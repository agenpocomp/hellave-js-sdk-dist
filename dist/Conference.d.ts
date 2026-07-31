import type { ConnectionQuality, ClientDiagnostics } from "./ConnectionQuality.js";
import { HellaveError } from "./contracts.js";
import type { RoomParticipant } from "./domain/RoomParticipant.js";
import type { RoomSnapshot } from "./domain/RoomSnapshot.js";
import { EventEmitter } from "./events/EventEmitter.js";
import { MediaDeviceController } from "./media/MediaDeviceController.js";
import type { MediaPublication } from "./media/MediaPublication.js";
import type { RemoteMicrophoneTrack } from "./media/RemoteMicrophoneTrack.js";
import type { RoomCommandOptions } from "./RoomCommand.js";
export interface SubscriptionPolicy {
    readonly audioEnabled?: boolean;
    readonly videoEnabled?: boolean;
    readonly maxVideoConsumers?: number;
    readonly pinnedPublications?: readonly string[];
    readonly preferredVideoLayer?: "low" | "medium" | "high";
}
export type ConferenceState = "waiting" | "admitted" | "degraded" | "reconnecting" | "denied" | "failed" | "left";
export interface NegotiatedControl {
    readonly contractRelease: string;
    readonly protocol: Readonly<{
        major: number;
        minor: number;
    }>;
    readonly capabilities: readonly string[];
}
export interface LobbyCommandResult {
    readonly commandId: string;
    readonly revision: number;
}
export interface ConferenceEvents {
    stateChanged: [state: ConferenceState];
    snapshotChanged: [snapshot: RoomSnapshot];
    admitted: [];
    denied: [error: HellaveError];
    error: [error: HellaveError];
    roomExpiring: [expiresAt: number];
    left: [];
    publicationAdded: [publication: MediaPublication];
    remoteMicrophoneTrack: [track: RemoteMicrophoneTrack];
    localMuteChanged: [publication: MediaPublication, muted: boolean];
    publishBlockChanged: [participant: RoomParticipant, mediaKind: "audio" | "video", blocked: boolean];
    spotlightChanged: [publicationId: string | null];
    connectionQualityChanged: [quality: ConnectionQuality];
}
/** One stable, server-authoritative attachment to a Room Instance. */
export declare class Conference extends EventEmitter<ConferenceEvents> {
    #private;
    readonly localParticipant: RoomParticipant;
    readonly negotiated: NegotiatedControl;
    private state_;
    private snapshot_;
    private terminalError_;
    private leavePromise;
    private expiresAt_;
    private readonly publishBlocks;
    private constructor();
    /**
     * Capture and publish this participant's microphone.
     *
     * The returned identity is reserved by Hellave before WebRTC binding and is
     * stable across transport recovery.
     */
    publishMicrophone(constraints?: boolean | MediaTrackConstraints, options?: RoomCommandOptions): Promise<MediaPublication>;
    get state(): ConferenceState;
    get snapshot(): RoomSnapshot;
    /** Inactive stable publications retained for application-driven recovery. */
    get publicationIntents(): readonly MediaPublication[];
    get terminalError(): HellaveError | null;
    /** Fixed terminal Room Instance expiry after the server announces it. */
    get expiresAt(): number | null;
    /** Current spotlight video publication identity or null when cleared. */
    get spotlight(): string | null;
    /** Set or clear the room-wide Spotlight video publication. */
    setSpotlight(publicationId: string | null, options?: RoomCommandOptions): Promise<LobbyCommandResult>;
    /** Retry control recovery explicitly after the configured Recovery Budget is exhausted. */
    retry(): Promise<void>;
    private deviceController_;
    get mediaDeviceController(): MediaDeviceController;
    get connectionQuality(): ConnectionQuality;
    requestDiagnostics(): Promise<ClientDiagnostics>;
    get roomId(): string;
    get roomInstanceId(): string;
    /** Admit one visible lobby participant and await the committed room revision. */
    admit(participantId: string, options?: RoomCommandOptions): Promise<LobbyCommandResult>;
    /** Deny one visible lobby participant and await the committed room revision. */
    deny(participantId: string, reason?: string, options?: RoomCommandOptions): Promise<LobbyCommandResult>;
    /** Apply or clear a server-enforced Publish Block without changing participant Local Mute. */
    setPublishBlock(participantId: string, mediaKind: "audio" | "video", blocked: boolean, options?: RoomCommandOptions): Promise<LobbyCommandResult>;
    /** Update the participant's private SFU subscription policy. */
    setSubscriptionPolicy(policy: SubscriptionPolicy, options?: RoomCommandOptions): Promise<LobbyCommandResult>;
    /** Raise one or more publication IDs to high priority in the local subscription policy. */
    pin(...publicationIds: string[]): Promise<LobbyCommandResult>;
    /** Remove publication priority preferences and reset to server-default subscription routing. */
    unpin(): Promise<LobbyCommandResult>;
    /**
     * Commit and acknowledge terminal membership leave, then close the attachment.
     * Repeated calls share one completion; a lost acknowledgement rejects as an unknown outcome.
     */
    leave(): Promise<void>;
    private installSnapshot;
    private validateLobbyCommand;
}
//# sourceMappingURL=Conference.d.ts.map