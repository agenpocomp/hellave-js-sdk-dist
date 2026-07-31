import { EventEmitter } from "../events/EventEmitter.js";
import type { ClientSignal, ServerSignal } from "./types.js";
type JoinedSignal = Extract<ServerSignal, {
    type: "joined";
}>;
export declare enum SignalingState {
    Disconnected = "disconnected",
    Connecting = "connecting",
    Connected = "connected",
    Reconnecting = "reconnecting"
}
interface SignalingEvents {
    open: [];
    close: [{
        code: number;
        reason: string;
    }];
    signal: [ServerSignal];
    error: [Error];
    stateChanged: [SignalingState];
}
export declare class SignalingClient extends EventEmitter<SignalingEvents> {
    private readonly url;
    private readonly tokenProvider;
    private ws;
    private state_;
    private reconnectAttempts;
    private reconnectTimer;
    private pingTimer;
    private intentionalClose;
    private messageBuffer;
    private connected_;
    constructor(url: string, tokenProvider: () => Promise<string>);
    get state(): SignalingState;
    connect(): void;
    private openSocket;
    send(signal: ClientSignal): void;
    refreshJoin(): Promise<JoinedSignal>;
    close(): void;
    private restartSocket;
    private setState;
    private onOpen;
    private onMessage;
    private onClose;
    private onWsError;
    private scheduleReconnect;
    private flushBuffer;
    private startPing;
    private clearReconnectTimer;
    private clearPingTimer;
}
export {};
//# sourceMappingURL=SignalingClient.d.ts.map