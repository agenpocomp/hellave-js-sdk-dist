import type { LobbyParticipant } from "./LobbyParticipant.js";
import type { RoomParticipant } from "./RoomParticipant.js";
import type { MediaPublication } from "../media/MediaPublication.js";
/** Immutable role-scoped room view at one authoritative revision. */
export declare class RoomSnapshot {
    readonly revision: number;
    readonly roomId: string;
    readonly roomInstanceId: string;
    readonly participants: readonly RoomParticipant[];
    readonly publications: readonly MediaPublication[];
    readonly lobby: readonly LobbyParticipant[];
    readonly spotlightPublicationId: string | null;
    constructor(revision: number, roomId: string, roomInstanceId: string, participants: readonly RoomParticipant[], publications: readonly MediaPublication[], lobby: readonly LobbyParticipant[], spotlightPublicationId: string | null);
}
//# sourceMappingURL=RoomSnapshot.d.ts.map