/** Capability-scoped identity for a participant waiting in the lobby. */
export class LobbyParticipant {
    id;
    profile;
    constructor(id, profile) {
        this.id = id;
        this.profile = Object.freeze({ ...profile });
        Object.freeze(this);
    }
}
//# sourceMappingURL=LobbyParticipant.js.map