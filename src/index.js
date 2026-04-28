#!/usr/bin/env node
"use strict";

/**
 * immi2mpeg – Node.js port of blinkpy/livestream.py
 * Port of blinkpy/livestream.py + amattu2/blink-liveview-middleware client API
 *
 * Connects to the Blink IMMI TCP server, receives MPEG-TS,
 * transmuxes to fMP4 via ffmpeg and forwards to WebSocket clients.
 *
 * Usage:
 *   node src/index.js [--port=8090] [--host=0.0.0.0]
 *
 * Debug:
 *   DEBUG=immi2mpeg:* node src/index.js
 */

const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const { BlinkLiveStream } = require("./livestream");
const { BlinkApi } = require("./blinkApi");

const dbg = {
    server: require("debug")("immi2mpeg:server"),
    ws: require("debug")("immi2mpeg:ws"),
    stream: require("debug")("immi2mpeg:stream"),
    ffmpeg: require("debug")("immi2mpeg:ffmpeg"),
    api: require("debug")("immi2mpeg:api"),
};


// ── Global EPIPE guard ────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
    if (err.code === "EPIPE") return;
    console.error("[uncaught]", err);
});

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, "").split("=");
        return [k, v ?? true];
    })
);

const PORT = parseInt(args.port ?? process.env.PORT ?? "8090", 10);
const HOST = args.host ?? process.env.HOST ?? "0.0.0.0";

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ host: HOST, port: PORT });

console.log(`[server] WebSocket endpoint: ws://${HOST}:${PORT}`);

const INIT_TIMEOUT_MS = 8_000;

wss.on("connection", (ws) => {
    console.log("[ws] client connected");

    let stream = null;
    let ffmpeg = null;

    const initTimer = setTimeout(() => {
        if (!stream) {
            console.warn("[ws] timeout waiting for liveview:start");
            ws.close(1008, "Timeout");
        }
    }, INIT_TIMEOUT_MS);

    // ── ffmpeg: MPEG-TS stdin → fMP4 stdout ──────────────────────────────────
    function startFfmpeg() {
        ffmpeg = spawn("ffmpeg", [
            "-loglevel", "warning",
            "-i", "pipe:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-bsf:a", "aac_adtstoasc",
            "-f", "mp4",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof+faststart",
            "pipe:1",
        ]);

        ffmpeg.stdout.on("data", (chunk) => {
            dbg.ffmpeg("sending %d bytes to client", chunk.length);
            if (ws.readyState === ws.OPEN) {
                ws.send(chunk);
            }
        });

        ffmpeg.stderr.on("data", (d) => {
            dbg.ffmpeg("%s", d.toString().trim());
        });

        ffmpeg.on("close", (code) => {
            dbg.ffmpeg("exited with code %d", code);
        });

        ffmpeg.on("error", (err) => {
            console.error("[ffmpeg] spawn error:", err.message);
        });

        ffmpeg.stdin.on("error", (err) => {
            if (err.code === "EPIPE") {
                dbg.ffmpeg("stdin EPIPE — ffmpeg closed, stopping stream");
                stream?.stop();
            } else {
                console.error("[ffmpeg] stdin error:", err.message);
            }
        });

        return ffmpeg;
    }

    ws.on("message", async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            ws.send(JSON.stringify({ error: "invalid JSON" }));
            return;
        }

        if (msg.command === "liveview:start") {
            clearTimeout(initTimer);
            const { account_region, api_token, account_id, network_id, camera_id, camera_type } = msg.data ?? {};

            try {
                // 1. Blink HTTP API → liveview session
                const blinkApi = new BlinkApi({ region: account_region, token: api_token });
                const lvResponse = await blinkApi.startLiveview({
                    accountId: account_id,
                    networkId: network_id,
                    cameraId: camera_id,
                    cameraType: camera_type,
                });
                dbg.api("liveview response: %o", lvResponse);

                // 2. Stream handler (serial resolved from URL path inside BlinkLiveStream)
                const cameraInfo = { networkId: network_id };
                stream = new BlinkLiveStream(cameraInfo, lvResponse, blinkApi);

                // 3. Start ffmpeg transmuxer
                startFfmpeg();

                // 4. MPEG-TS chunks → ffmpeg stdin
                stream.on("data", (chunk) => {
                    dbg.stream("forwarding %d bytes to ffmpeg", chunk.length);
                    if (ffmpeg && ffmpeg.stdin.writable && !ffmpeg.stdin.destroyed) {
                        try {
                            ffmpeg.stdin.write(chunk);
                        } catch (err) {
                            dbg.ffmpeg("stdin write error: %s", err.message);
                        }
                    }
                });

                stream.on("stop", () => {
                    ffmpeg?.stdin?.end();
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ command: "liveview:stop" }));
                    }
                    ws.close();
                });

                stream.on("error", (err) => {
                    
                    console.error("[stream] error:", err.message);
                    ffmpeg?.stdin?.end();
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ command: "liveview:stop", error: err.message }));
                    }
                    ws.close();
                });

                // 5. Notify client — stream is opening
                ws.send(JSON.stringify({ command: "liveview:start" }));
                console.log("[ws] liveview:start → connecting to Blink TCP server");

                // 6. Connect to Blink IMMI TCP server
                stream.connect().catch((err) => {
                    console.error("[stream] connect error:", err.message);
                    ffmpeg?.stdin?.end();
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ command: "liveview:stop", error: err.message }));
                    }
                    ws.close();
                });

            } catch (err) {
                console.error("[ws] failed to start liveview:", err.message);
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ command: "liveview:stop", error: err.message }));
                }
                ws.close();
            }

        } else if (msg.command === "liveview:stop") {
            dbg.ws("liveview:stop requested by client");
            stream?.stop();
            ffmpeg?.stdin?.end();
        }
    });

    ws.on("close", () => {
        clearTimeout(initTimer);
        stream?.stop();
        ffmpeg?.stdin?.end();
        ffmpeg?.kill("SIGTERM");
        console.log("[ws] client disconnected");
    });

    ws.on("error", (err) => {
        console.error("[ws] error:", err.message);
    });
});

wss.on("error", (err) => {
    console.error("[server] error:", err.message);
    process.exit(1);
});
