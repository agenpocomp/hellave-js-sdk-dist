export type ConnectionQuality = "excellent" | "good" | "fair" | "poor" | "failed";
export interface ClientDiagnostics {
    rtt: number;
    jitter: number;
    packetLoss: number;
    bitrate: number;
    /** ICE candidate type of the selected pair: host, srflx, prflx, relay, or unknown. */
    candidateType: string;
    /** Transport of the selected local candidate: udp, tcp, or unknown. */
    protocol: string;
    quality: ConnectionQuality;
    timestamp: number;
}
//# sourceMappingURL=ConnectionQuality.d.ts.map