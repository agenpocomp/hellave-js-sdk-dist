/**
 * A received microphone track associated with stable domain identities.
 *
 * The native track is available for playback; transport identities are not.
 */
export class RemoteMicrophoneTrack {
    publicationId;
    ownerParticipantId;
    mediaStreamTrack;
    constructor(publicationId, ownerParticipantId, mediaStreamTrack) {
        this.publicationId = publicationId;
        this.ownerParticipantId = ownerParticipantId;
        this.mediaStreamTrack = mediaStreamTrack;
    }
}
//# sourceMappingURL=RemoteMicrophoneTrack.js.map