import { HellaveError } from "../contracts.js";
const mutablePublicationState = new WeakMap();
/**
 * Stable server-authoritative publication identity.
 *
 * WebRTC sender and transceiver details deliberately remain inside the SDK.
 */
export class MediaPublication {
    id;
    ownerParticipantId;
    source;
    constructor(id, ownerParticipantId, source) {
        this.id = id;
        this.ownerParticipantId = ownerParticipantId;
        this.source = source;
        mutablePublicationState.set(this, {
            control: null,
            state: "active",
            stopPromise: null,
            localMuted: false,
        });
    }
    get state() {
        return publicationState(this).state;
    }
    /** Participant-private capture choice; hosts cannot clear or activate it. */
    get localMuted() {
        return publicationState(this).localMuted;
    }
    /** Toggle participant-owned Local Mute without changing server Publish Block policy. */
    setLocalMuted(muted) {
        const control = publicationState(this).control;
        if (!control) {
            throw new HellaveError("authorization_denied", "Only the owning participant can change Local Mute.");
        }
        control.setLocalMute(this.id, muted);
    }
    /** Stop forwarding before releasing the server-side publication reservation. */
    stop(options) {
        const mutable = publicationState(this);
        if (!mutable.control) {
            return Promise.reject(new HellaveError("authorization_denied", "Only the owning participant can stop this publication."));
        }
        if (mutable.stopPromise)
            return mutable.stopPromise;
        mutable.stopPromise = mutable.control
            .unpublish(this.id, options?.commandId)
            .then(() => {
            mutable.state = "stopped";
        })
            .catch((error) => {
            mutable.stopPromise = null;
            throw error;
        });
        return mutable.stopPromise;
    }
}
/** @internal Attach owner operations without exposing the transport on the public object. */
export function bindPublicationOwner(publication, control) {
    publicationState(publication).control = control;
}
/** @internal Apply authoritative removal. */
export function markPublicationStopped(publication) {
    publicationState(publication).state = "stopped";
}
/** @internal Apply authoritative activation or replacement. */
export function markPublicationActive(publication) {
    const mutable = publicationState(publication);
    mutable.state = "active";
    mutable.stopPromise = null;
}
/** @internal Apply participant-owned Local Mute after changing capture flow. */
export function markLocalMuted(publication, muted) {
    publicationState(publication).localMuted = muted;
}
function publicationState(publication) {
    const state = mutablePublicationState.get(publication);
    if (!state)
        throw new Error("MediaPublication was not initialized.");
    return state;
}
//# sourceMappingURL=MediaPublication.js.map