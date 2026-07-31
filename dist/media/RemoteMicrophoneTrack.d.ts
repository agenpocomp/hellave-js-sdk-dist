/**
 * A received microphone track associated with stable domain identities.
 *
 * The native track is available for playback; transport identities are not.
 */
export declare class RemoteMicrophoneTrack {
    readonly publicationId: string;
    readonly ownerParticipantId: string;
    readonly mediaStreamTrack: MediaStreamTrack;
    constructor(publicationId: string, ownerParticipantId: string, mediaStreamTrack: MediaStreamTrack);
}
//# sourceMappingURL=RemoteMicrophoneTrack.d.ts.map