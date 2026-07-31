const mutableParticipantState = new WeakMap();
/** Server-authorized participant identity exposed by the stable SDK. */
export class RoomParticipant {
    id;
    constructor(id, profile, role, capabilities, muted, publishBlocked = { audio: false, video: false }) {
        this.id = id;
        mutableParticipantState.set(this, freezeParticipantState(profile, role, capabilities, muted, publishBlocked));
    }
    get profile() {
        return participantState(this).profile;
    }
    get role() {
        return participantState(this).role;
    }
    get capabilities() {
        return participantState(this).capabilities;
    }
    get muted() {
        return participantState(this).muted;
    }
    /** Server-enforced publish policy; independent from participant-private Local Mute. */
    get publishBlocked() {
        return participantState(this).publishBlocked;
    }
}
/** @internal Reconcile committed state without exposing mutation on the public object. */
export function reconcileRoomParticipant(participant, profile, role, capabilities, muted, publishBlocked = { audio: false, video: false }) {
    mutableParticipantState.set(participant, freezeParticipantState(profile, role, capabilities, muted, publishBlocked));
}
function freezeParticipantState(profile, role, capabilities, muted, publishBlocked) {
    return {
        profile: Object.freeze({ ...profile }),
        role,
        capabilities: Object.freeze({ ...capabilities }),
        muted: Object.freeze({ ...muted }),
        publishBlocked: Object.freeze({ ...publishBlocked }),
    };
}
function participantState(participant) {
    const state = mutableParticipantState.get(participant);
    if (!state)
        throw new Error("RoomParticipant was not initialized.");
    return state;
}
//# sourceMappingURL=RoomParticipant.js.map