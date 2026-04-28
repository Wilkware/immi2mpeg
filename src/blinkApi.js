"use strict";

/**
 * BlinkApi – minimal Blink HTTP API client for the liveview flow.
 *
 * Covers the endpoints needed by the livestream service:
 *   POST /api/v5/accounts/{accountId}/networks/{networkId}/cameras/{cameraId}/liveview
 *   GET  /network/{networkId}/command/{commandId}
 *   POST /network/{networkId}/command/{commandId}/done
 */

const https = require("https");
const debug = require("debug")("immi2mpeg:api");

// Blink uses region-specific base URLs, e.g. u014.immedia-semi.com
const BASE_URL = (region) =>
    region ? `https://rest-${region}.immedia-semi.com` : "https://rest-prod.immedia-semi.com";

/**
 * Minimal fetch wrapper using Node's built-in https module.
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: object }} [opts]
 */
function request(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: opts.method ?? "GET",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
                ...(opts.headers ?? {}),
            },
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on("data", (d) => chunks.push(d));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(raw) });
                } catch {
                    resolve({ status: res.statusCode, body: raw });
                }
            });
        });

        req.on("error", reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

class BlinkApi {
    /**
     * @param {{ region: string, token: string, accountId?: string }} opts
     */
    constructor({ region, token, accountId } = {}) {
        this.region = region;
        this.token = token;
        this.accountId = accountId;
        this.baseUrl = BASE_URL(region);
    }

    _headers() {
        return {
            "Authorization": `Bearer ${this.token ?? ""}`,
            "Content-Type": "application/json",
        };
    }

    // ── Liveview ───────────────────────────────────────────────────────────────

    /**
     * Start a liveview session for a camera.
     * Returns the server URL, command_id, and polling_interval.
     *
     * @param {{ accountId: string, networkId: string, cameraId: string, cameraType: string }} opts
     */
    async startLiveview({ accountId, networkId, cameraId, cameraType }) {
        const accId = accountId ?? this.accountId;

        // The endpoint differs slightly by camera type (owl = mini, regular = camera)
        const isOwl = (cameraType ?? "").toLowerCase() === "owl";
        const path = isOwl
            ? `/api/v1/accounts/${accId}/networks/${networkId}/owls/${cameraId}/liveview`
            : `/api/v5/accounts/${accId}/networks/${networkId}/cameras/${cameraId}/liveview`;

        const url = `${this.baseUrl}${path}`;
        debug("POST %s", url);
        
        const resp = await request(url, {
            method: "POST",
            headers: this._headers(),
            body: {},
        });

        if (resp.status !== 200) {
            throw new Error(
                `startLiveview failed: ${resp.status} ${JSON.stringify(resp.body)}`
            );
        }

        return resp.body;
    }

    // ── Command management ────────────────────────────────────────────────────

    /**
     * Poll the command status (used to keep the liveview alive).
     * Mirrors blinkpy api.request_command_status
     *
     * @param {string|number} networkId
     * @param {string|number} commandId
     */
    async getCommandStatus(networkId, commandId) {
        const url = `${this.baseUrl}/network/${networkId}/command/${commandId}`;
        debug("GET %s", url);

        const resp = await request(url, { headers: this._headers() });
        return resp.body;
    }

    /**
     * Signal that the liveview command is done.
     * Mirrors blinkpy api.request_command_done
     *
     * @param {string|number} networkId
     * @param {string|number} commandId
     */
    async commandDone(networkId, commandId) {
        const url = `${this.baseUrl}/network/${networkId}/command/${commandId}/done`;
        debug("POST %s", url);

        const resp = await request(url, {
            method: "POST",
            headers: this._headers(),
            body: {},
        });
        return resp.body;
    }

}

module.exports = { BlinkApi };
