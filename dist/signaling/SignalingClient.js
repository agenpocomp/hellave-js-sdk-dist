import { EventEmitter } from "../events/EventEmitter.js";
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 10_000;
const REFRESH_JOIN_TIMEOUT_MS = 10_000;
export var SignalingState;
(function (SignalingState) {
    SignalingState["Disconnected"] = "disconnected";
    SignalingState["Connecting"] = "connecting";
    SignalingState["Connected"] = "connected";
    SignalingState["Reconnecting"] = "reconnecting";
})(SignalingState || (SignalingState = {}));
const VALID_FIRST_SIGNALS = new Set(["joined", "lobby_waiting", "peer_denied", "pong"]);
export class SignalingClient extends EventEmitter {
    url;
    tokenProvider;
    ws = null;
    state_ = SignalingState.Disconnected;
    reconnectAttempts = 0;
    reconnectTimer = null;
    pingTimer = null;
    intentionalClose = false;
    messageBuffer = [];
    connected_ = false;
    constructor(url, tokenProvider) {
        super();
        this.url = url;
        this.tokenProvider = tokenProvider;
    }
    get state() {
        return this.state_;
    }
    connect() {
        if (this.state_ === SignalingState.Connected || this.state_ === SignalingState.Connecting) {
            return;
        }
        this.intentionalClose = false;
        this.connected_ = false;
        this.setState(SignalingState.Connecting);
        this.openSocket().catch((error) => {
            this.emit("error", error instanceof Error ? error : new Error(String(error)));
            this.setState(SignalingState.Disconnected);
            if (!this.intentionalClose)
                this.scheduleReconnect();
        });
    }
    async openSocket() {
        const token = await this.tokenProvider();
        if (this.intentionalClose)
            return;
        this.ws = new WebSocket(this.url);
        this.ws.onopen = () => this.onOpen(token);
        this.ws.onmessage = (event) => this.onMessage(event);
        this.ws.onclose = (event) => this.onClose(event.code, event.reason);
        this.ws.onerror = () => this.onWsError();
    }
    send(signal) {
        const payload = JSON.stringify(signal);
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(payload);
        }
        else {
            this.messageBuffer.push(payload);
        }
    }
    async refreshJoin() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error("signaling refresh timed out"));
            }, REFRESH_JOIN_TIMEOUT_MS);
            const cleanup = () => {
                clearTimeout(timeout);
                this.off("signal", onSignal);
                this.off("error", onError);
            };
            const onSignal = (signal) => {
                if (signal.type === "joined") {
                    cleanup();
                    resolve(signal);
                }
                else if (signal.type === "error") {
                    cleanup();
                    reject(new Error(signal.message));
                }
                else if (signal.type === "peer_denied") {
                    cleanup();
                    reject(new Error(signal.reason ?? "signaling refresh denied"));
                }
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            this.on("signal", onSignal);
            this.on("error", onError);
            this.restartSocket().catch(onError);
        });
    }
    close() {
        this.intentionalClose = true;
        this.clearReconnectTimer();
        this.clearPingTimer();
        this.messageBuffer = [];
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close(1000, "client close");
            }
            this.ws = null;
        }
        this.connected_ = false;
        this.setState(SignalingState.Disconnected);
        this.reconnectAttempts = 0;
    }
    async restartSocket() {
        this.clearReconnectTimer();
        this.clearPingTimer();
        this.intentionalClose = false;
        this.connected_ = false;
        const previous = this.ws;
        this.ws = null;
        if (previous) {
            previous.onclose = null;
            previous.onerror = null;
            if (previous.readyState === WebSocket.OPEN || previous.readyState === WebSocket.CONNECTING) {
                previous.close(1000, "session refresh");
            }
        }
        this.setState(SignalingState.Reconnecting);
        await this.openSocket();
    }
    setState(state) {
        if (this.state_ !== state) {
            this.state_ = state;
            this.emit("stateChanged", state);
        }
    }
    onOpen(token) {
        this.reconnectAttempts = 0;
        this.flushBuffer(token);
    }
    onMessage(event) {
        if (!this.connected_) {
            try {
                const signal = JSON.parse(event.data);
                if (VALID_FIRST_SIGNALS.has(signal.type)) {
                    if (signal.type === "joined") {
                        this.connected_ = true;
                        this.setState(SignalingState.Connected);
                        this.startPing();
                    }
                    this.emit("signal", signal);
                    return;
                }
                this.emit("error", new Error("expected join/lobby signal, got: " + signal.type));
                return;
            }
            catch (error) {
                this.emit("error", error instanceof Error ? error : new Error(String(error)));
                return;
            }
        }
        try {
            const signal = JSON.parse(event.data);
            this.emit("signal", signal);
        }
        catch (error) {
            this.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
    }
    onClose(code, reason) {
        this.clearPingTimer();
        this.connected_ = false;
        this.setState(SignalingState.Disconnected);
        this.emit("close", { code, reason });
        if (!this.intentionalClose) {
            this.scheduleReconnect();
        }
    }
    onWsError() {
        this.emit("error", new Error("WebSocket error"));
    }
    scheduleReconnect() {
        this.clearReconnectTimer();
        if (this.state_ === SignalingState.Connected || this.state_ === SignalingState.Connecting) {
            this.setState(SignalingState.Reconnecting);
        }
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_DELAY_MS);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }
    flushBuffer(token) {
        if (!this.ws)
            return;
        this.send({ type: "join", token });
        for (const msg of this.messageBuffer) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(msg);
            }
        }
        this.messageBuffer = [];
    }
    startPing() {
        this.clearPingTimer();
        this.pingTimer = setInterval(() => {
            this.send({ type: "ping" });
        }, PING_INTERVAL_MS);
    }
    clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    clearPingTimer() {
        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
}
//# sourceMappingURL=SignalingClient.js.map