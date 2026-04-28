"use strict";

/**
 * immi2mpeg – Node.js port of blinkpy/livestream.py
 *
 * Connects to the Blink IMMI TCP server, authenticates with a binary auth
 * header, and forwards MPEG-TS transport stream packets (msgtype 0x00) to
 * registered listeners via EventEmitter.
 *
 * Protocol reference:
 *   https://github.com/fronzbot/blinkpy/blob/dev/blinkpy/livestream.py
 *   https://github.com/amattu2/blink-liveview-middleware
 */

const tls = require("tls");
const { URL } = require("url");
const { EventEmitter } = require("events");
const debug = require("debug")("immi2mpeg:stream");

// IMMI protocol constants
const MSGTYPE_VIDEO = 0x00;
const MSGTYPE_KEEPALIVE = 0x0a;
const MSGTYPE_LATENCY = 0x12;
const HEADER_SIZE = 9; // 1-byte msgtype + 4-byte sequence + 4-byte payload length

const KEEPALIVE_INTERVAL_MS = 1_000; // keepalive every 1 s, latency every 10 s
const POLL_INTERVAL_BASE_MS = 1_000; // multiplied by pollingInterval from server response

/**
 * Pre-built latency stats packet (all-zeros stats, matches Python source).
 */
const LATENCY_STATS_PACKET = Buffer.from([
    // 9-byte header
    MSGTYPE_LATENCY, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x00, 0x18,
    // 4-byte audioAverageLatencyInMS
    0x00, 0x00, 0x00, 0x00,
    // 4-byte audioMaxLatencyInMS
    0x00, 0x00, 0x00, 0x00,
    // 2-byte audioFramesPresented
    0x00, 0x00,
    // 2-byte audioFramesDropped
    0x00, 0x00,
    // 4-byte videoAverageLatencyInMS
    0x00, 0x00, 0x00, 0x00,
    // 4-byte videoMaxLatencyInMS
    0x00, 0x00, 0x00, 0x00,
    // 2-byte videoFramesPresented
    0x00, 0x00,
    // 2-byte videoFramesDropped
    0x00, 0x00,
]);

class BlinkLiveStream extends EventEmitter {
    /**
     * @param {{ serial: string, networkId: string|number }} camera
     * @param {{
     *   server: string,
     *   command_id: number|string,
     *   polling_interval: number,
     *   liveview_token: string,
     *   camera_serial?: string
     * }} response
     * @param {import('./blinkApi').BlinkApi} blinkApi
     */
    constructor(camera, response, blinkApi) {
        super();

        this.commandId = response.command_id;
        this.pollingInterval = response.polling_interval ?? 5;
        this.targetUrl = new URL(response.server);
        this.liveviewToken = response.liveview_token ?? "";
        this.blinkApi = blinkApi;

        // Camera serial: prefer explicit field, then parse from server URL path
        // Server URL path looks like: /v5u-YtH94za4sn0t__IMDS_G8T1GJ0125131KMU
        // The part after __IMDS_ is the serial
        const urlPathSerial = this.targetUrl.pathname
            .split("/").pop()    // "fS6bLwz5pzhLqbfD__IMDS_G8T1GJ0125131KMU"
            .split("__")[1]      // "IMDS_G8T1GJ0125131KMU"
            ?.replace(/^IMDS_/, "") // "G8T1GJ0125131KMU"  ← Serial
            ?? "";

        this.camera = {
            ...camera,
            serial: camera.serial || response.camera_serial || urlPathSerial,
        };

        debug("serial: %s  liveview_token: %s", this.camera.serial, this.liveviewToken);

        /** @type {tls.TLSSocket|null} */
        this._socket = null;
        this._stopped = false;
        this._keepaliveTimer = null;
        this._pollTimer = null;
        this._sequence = 0;

        // Streaming buffer state
        this._buf = Buffer.alloc(0);
        this._expectedPayload = -1;   // -1 = waiting for header
        this._pendingHeader = null; // parsed header fields
    }

    // ── Auth header construction (matches Python get_auth_header) ──────────────

    /**
     * Append a fixed-length, null-padded UTF-8 string field
     * (4-byte big-endian length prefix + padded bytes) to a parts array.
     */
    _addStringField(parts, str, maxLen) {
        const raw = Buffer.from(str ?? "", "utf8").slice(0, maxLen);
        const padded = Buffer.alloc(maxLen, 0);
        raw.copy(padded);

        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(maxLen);
        parts.push(lenBuf, padded);
    }

    _buildAuthHeader() {
        const SERIAL_MAX = 16;
        const TOKEN_MAX = 64;
        const CONN_ID_MAX = 16;

        const parts = [];

        // Magic number (4 bytes): 0x00000028
        parts.push(Buffer.from([0x00, 0x00, 0x00, 0x28]));

        // Device serial field (4-byte length prefix + 16 bytes)
        this._addStringField(parts, this.camera.serial, SERIAL_MAX);

        // Client ID field (4 bytes, big-endian int) — from ?client_id= query param
        const params = new URLSearchParams(this.targetUrl.search);
        const clientId = parseInt(params.get("client_id") ?? "0", 10);
        const clientIdBuf = Buffer.alloc(4);
        clientIdBuf.writeUInt32BE(clientId);
        parts.push(clientIdBuf);

        // Static field (2 bytes)
        parts.push(Buffer.from([0x01, 0x08]));

        // Auth token field (4-byte length prefix + 64 bytes)
        // Use liveview_token from the API response, padded/truncated to TOKEN_MAX
        const tokenRaw = Buffer.from(this.liveviewToken, "utf8").slice(0, TOKEN_MAX);
        const tokenPadded = Buffer.alloc(TOKEN_MAX, 0);
        tokenRaw.copy(tokenPadded);
        const tokenLen = Buffer.alloc(4);
        tokenLen.writeUInt32BE(TOKEN_MAX);
        parts.push(tokenLen, tokenPadded);

        // Connection ID field (4-byte length prefix + 16 bytes)
        // Path: /v5u-YtH94za4sn0t__IMDS_G8T1GJ0125131KMU → conn_id = "v5u-YtH94za4sn0t"
        const connId = this.targetUrl.pathname.split("/").pop().split("__")[0];
        debug("conn_id: %s  client_id: %d", connId, clientId);
        this._addStringField(parts, connId, CONN_ID_MAX);

        // Trailer (4 bytes)
        parts.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));

        const header = Buffer.concat(parts);
        debug("auth header: %d bytes", header.length);
        return header;
    }

    // ── Keepalive / latency sender (mirrors Python send()) ────────────────────

    _buildKeepalivePacket(seq) {
        const pkt = Buffer.alloc(9, 0);
        pkt[0] = MSGTYPE_KEEPALIVE;
        pkt.writeUInt32BE(seq, 1);
        // payload length bytes 5-8 remain 0
        return pkt;
    }

    _startKeepalive() {
        let everyTen = 0;
        this._keepaliveTimer = setInterval(() => {
            if (!this._socket || this._socket.destroyed) return;

            if (everyTen % 10 === 0) {
                everyTen = 0;
                this._sequence += 1;
                const ka = this._buildKeepalivePacket(this._sequence);
                this._socket.write(ka);
                this._socket.write(LATENCY_STATS_PACKET);
                debug("keepalive #%d", this._sequence);
            }
            everyTen++;
        }, KEEPALIVE_INTERVAL_MS);
    }

    // ── Command polling (mirrors Python poll()) ────────────────────────────────

    _startPolling() {
        const intervalMs = this.pollingInterval * POLL_INTERVAL_BASE_MS;

        const tick = async () => {
            if (this._stopped) return;

            try {
                const resp = await this.blinkApi.getCommandStatus(
                    this.camera.networkId,
                    this.commandId
                );

                if ((resp?.status_code ?? 0) !== 908) {
                    console.error("[poll] unexpected status:", resp);
                    this.stop();
                    return;
                }

                const commands = resp.commands ?? [];
                const cmd = commands.find((c) => c.id == this.commandId);
                if (!cmd) {
                    console.debug("[poll] command not found, stopping");
                    this.stop();
                    return;
                }

                const state = cmd.state_condition;
                debug("poll state: %s", state);

                if (state !== "new" && state !== "running") {
                    this.stop();
                    return;
                }
            } catch (err) {
                console.error("[poll] error:", err.message);
                this.stop();
                return;
            }

            if (!this._stopped) {
                this._pollTimer = setTimeout(tick, intervalMs);
            }
        };

        this._pollTimer = setTimeout(tick, intervalMs);
    }

    // ── IMMI stream parser (mirrors Python recv()) ─────────────────────────────

    /**
     * Process incoming data from the Blink TCP server.
     * IMMI protocol frame:
     *   [1-byte msgtype][4-byte sequence][4-byte payload_length][payload]
     */
    _processData(chunk) {
        this._buf = Buffer.concat([this._buf, chunk]);

        while (true) {
            if (this._pendingHeader === null) {
                // Need at least 9 bytes for the header
                if (this._buf.length < HEADER_SIZE) break;

                const msgtype = this._buf[0];
                const sequence = this._buf.readUInt32BE(1);
                const payloadLength = this._buf.readUInt32BE(5);
                this._buf = this._buf.slice(HEADER_SIZE);

                debug("recv msgtype=0x%s seq=%d paylen=%d",
                    msgtype.toString(16).padStart(2, "0"), sequence, payloadLength);

                if (payloadLength <= 0) {
                    // No payload — process next packet immediately
                    continue;
                }

                this._pendingHeader = { msgtype, sequence, payloadLength };
                this._expectedPayload = payloadLength;
            }

            // Wait until full payload has arrived
            if (this._buf.length < this._expectedPayload) break;

            const payload = this._buf.slice(0, this._expectedPayload);
            this._buf = this._buf.slice(this._expectedPayload);
            const { msgtype } = this._pendingHeader;
            this._pendingHeader = null;
            this._expectedPayload = -1;

            // Only forward regular video stream packets (msgtype 0x00)
            if (msgtype !== MSGTYPE_VIDEO) {
                debug("skipping msgtype 0x%s", msgtype.toString(16).padStart(2, "0"));
                continue;
            }

            // Skip video payloads missing the MPEG-TS sync byte 0x47
            if (payload[0] !== 0x47) {
                debug("skipping payload missing 0x47 sync byte");
                continue;
            }
            debug("forwarding %d bytes", payload.length);
            this.emit("data", payload);
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Connect to the Blink IMMI TCP server and start streaming.
     * Resolves once authentication is sent; rejects on connection error.
     */
    connect() {
        return new Promise((resolve, reject) => {
            if (this._stopped) {
                return reject(new Error("stream is already stopped"));
            }

            const hostname = this.targetUrl.hostname;
            const port = parseInt(this.targetUrl.port, 10) || 443;

            console.log(`[stream] connecting to ${hostname}:${port} (TLS)`);

            const socket = tls.connect(
                { host: hostname, port, rejectUnauthorized: false },
                () => {
                    console.log("[stream] TLS connected, sending auth header");
                    const authHeader = this._buildAuthHeader();
                    socket.write(authHeader, () => {
                        debug("auth header sent");
                        this._startKeepalive();
                        this._startPolling();
                        resolve();
                    });
                }
            );

            this._socket = socket;

            socket.on("data", (chunk) => {
                try {
                    this._processData(chunk);
                } catch (err) {
                    console.error("[recv] processing error:", err.message);
                }
            });

            socket.on("end", () => {
                debug("server closed connection"); this.stop();
                this.stop();
            });

            socket.on("error", (err) => {
                console.error("[stream] socket error:", err.message);
                if (!this._stopped) {
                    this.emit("error", err);
                    this.stop();
                }
                reject(err);
            });

            socket.on("close", () => {
                if (!this._stopped) this.stop();
            });
        });
    }

    /**
     * Stop the stream and release all resources.
     * Notifies Blink that the command is done.
     */
    stop() {
        if (this._stopped) return;
        this._stopped = true;

        clearInterval(this._keepaliveTimer);
        clearTimeout(this._pollTimer);

        if (this._socket && !this._socket.destroyed) {
            this._socket.destroy();
        }

        console.log("[stream] stopped");
        this.emit("stop");

        // Fire-and-forget: notify Blink the command is done
        this.blinkApi
            .commandDone(this.camera.networkId, this.commandId)
            .catch((err) => debug("commandDone error: %s", err.message));
    }

    get isActive() {
        return !this._stopped && this._socket && !this._socket.destroyed;
    }
}

module.exports = { BlinkLiveStream };
