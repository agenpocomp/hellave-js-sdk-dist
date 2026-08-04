import { Conference } from "./Conference.js";
import { HellaveError } from "./contracts.js";
import { ControlClient, } from "./control/ControlClient.js";
/** Browser entry point for stable Hellave domain operations. */
export class HellaveClient {
    controlClient;
    conference_ = null;
    attachment = null;
    constructor(config) {
        const socketUrl = publicControlSocketUrl(config.controlUrl);
        if (typeof config.tokenProvider !== "function") {
            throw new TypeError("HellaveConfig.tokenProvider must be a function");
        }
        const timeoutMs = config.attachTimeoutMs ?? 10_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new TypeError("HellaveConfig.attachTimeoutMs must be positive");
        }
        const recoveryBudgetMs = config.recoveryBudgetMs ?? 120_000;
        if (!Number.isFinite(recoveryBudgetMs) || recoveryBudgetMs <= 0) {
            throw new TypeError("HellaveConfig.recoveryBudgetMs must be positive");
        }
        this.controlClient = new ControlClient(socketUrl, config.tokenProvider, timeoutMs, recoveryBudgetMs);
    }
    get conference() {
        return this.conference_;
    }
    attach(options) {
        if (this.conference_) {
            return Promise.reject(new HellaveError("conflict", "Already attached; leave first."));
        }
        const key = `${options.roomId}\u0000${options.roomInstanceId}`;
        if (this.attachment) {
            if (this.attachment.key === key)
                return this.attachment.promise;
            return Promise.reject(new HellaveError("conflict", "Another attachment is already in progress."));
        }
        const promise = this.controlClient
            .attach(options.roomId, options.roomInstanceId, options.signal)
            .then((attachment) => {
            const conference = Conference.create(attachment.participant, attachment.snapshot, attachment.conferenceState, attachment.negotiated, attachment.session);
            conference.on("left", () => {
                if (this.conference_ === conference)
                    this.conference_ = null;
            });
            this.conference_ = conference;
            return conference;
        })
            .finally(() => {
            if (this.attachment?.promise === promise)
                this.attachment = null;
        });
        this.attachment = { key, promise };
        return promise;
    }
    async leave() {
        await this.conference_?.leave();
    }
}
/**
 * Whether an origin is a loopback address.
 *
 * Loopback is a secure context by definition (W3C secure contexts), which is why browsers
 * allow getUserMedia there over plain HTTP. Requiring TLS for it blocked the SDK from being
 * pointed at a development stack at all, with no way to opt in.
 */
function isLoopback(url) {
    return url.hostname === "localhost"
        || url.hostname === "127.0.0.1"
        || url.hostname === "[::1]"
        || url.hostname === "::1";
}
function publicControlSocketUrl(input) {
    let url;
    try {
        url = new URL(input);
    }
    catch {
        throw new TypeError("HellaveConfig.controlUrl must be a valid HTTPS origin");
    }
    const secureTransport = url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url));
    if (!secureTransport
        || url.username
        || url.password
        || (url.pathname !== "/" && url.pathname !== "")
        || url.search
        || url.hash) {
        throw new TypeError("HellaveConfig.controlUrl must be one HTTPS origin");
    }
    // Plain ws only ever follows plain http on loopback; anything reachable stays wss.
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/control";
    return url.toString();
}
//# sourceMappingURL=HellaveClient.js.map