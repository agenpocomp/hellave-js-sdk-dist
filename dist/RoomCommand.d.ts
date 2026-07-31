/** Options shared by acknowledged, retryable Room Commands. */
export interface RoomCommandOptions {
    /**
     * Stable caller-generated identity.
     *
     * Reuse this value only with identical input after reconciling an unknown
     * outcome. Concurrent commands must use different identities.
     */
    readonly commandId?: string;
}
//# sourceMappingURL=RoomCommand.d.ts.map