import type { RoomCommandOptions } from "../RoomCommand.js";
export type MediaPublicationState = "active" | "stopped";
export type MediaPublicationSource = "microphone" | "camera" | "screen" | "screen_audio";
/**
 * Stable server-authoritative publication identity.
 *
 * WebRTC sender and transceiver details deliberately remain inside the SDK.
 */
export declare class MediaPublication {
    readonly id: string;
    readonly ownerParticipantId: string;
    readonly source: MediaPublicationSource;
    constructor(id: string, ownerParticipantId: string, source: MediaPublicationSource);
    get state(): MediaPublicationState;
    /** Participant-private capture choice; hosts cannot clear or activate it. */
    get localMuted(): boolean;
    /** Toggle participant-owned Local Mute without changing server Publish Block policy. */
    setLocalMuted(muted: boolean): void;
    /** Stop forwarding before releasing the server-side publication reservation. */
    stop(options?: RoomCommandOptions): Promise<void>;
}
//# sourceMappingURL=MediaPublication.d.ts.map