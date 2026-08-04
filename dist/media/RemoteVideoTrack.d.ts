/**
 * A received camera or screen-share track associated with stable domain identities.
 *
 * The native track is available for playback; transport identities are not. Mirrors
 * {@link RemoteMicrophoneTrack} so callers handle both kinds the same way.
 *
 * The Public Edge sends no message when a remote publication stops, so a consumer that renders
 * this should listen for `ended` and `mute` on {@link mediaStreamTrack} to know when to clear
 * the video element — otherwise the last decoded frame stays on screen indefinitely.
 */
export declare class RemoteVideoTrack {
    readonly publicationId: string;
    readonly ownerParticipantId: string;
    readonly mediaStreamTrack: MediaStreamTrack;
    constructor(publicationId: string, ownerParticipantId: string, mediaStreamTrack: MediaStreamTrack);
}
//# sourceMappingURL=RemoteVideoTrack.d.ts.map