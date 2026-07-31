/** Immutable role-scoped room view at one authoritative revision. */
export class RoomSnapshot {
    revision;
    roomId;
    roomInstanceId;
    participants;
    publications;
    lobby;
    spotlightPublicationId;
    constructor(revision, roomId, roomInstanceId, participants, publications, lobby, spotlightPublicationId) {
        this.revision = revision;
        this.roomId = roomId;
        this.roomInstanceId = roomInstanceId;
        this.participants = Object.freeze([...participants]);
        this.publications = Object.freeze([...publications]);
        this.lobby = Object.freeze([...lobby]);
        this.spotlightPublicationId = spotlightPublicationId;
        Object.freeze(this);
    }
}
//# sourceMappingURL=RoomSnapshot.js.map