export interface TokenProviderContext {
    roomId: string;
    roomInstanceId: string;
    reason: "attach" | "refresh" | "reconnect";
    priorSessionId?: string;
    signal: AbortSignal;
}
export type TokenProvider = (context: TokenProviderContext) => Promise<{
    token: string;
}>;
//# sourceMappingURL=TokenProvider.d.ts.map