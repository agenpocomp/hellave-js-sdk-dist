export type ConnectionQuality = "excellent" | "good" | "fair" | "poor" | "failed";
export interface ClientDiagnostics {
    rtt: number;
    jitter: number;
    packetLoss: number;
    bitrate: number;
    quality: ConnectionQuality;
    timestamp: number;
}
//# sourceMappingURL=ConnectionQuality.d.ts.map