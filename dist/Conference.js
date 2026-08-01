import { HellaveError } from "./contracts.js";
import { EventEmitter } from "./events/EventEmitter.js";
import { MediaDeviceController, } from "./media/MediaDeviceController.js";
/** One stable, server-authoritative attachment to a Room Instance. */
export class Conference extends EventEmitter {
    localParticipant;
    negotiated;
    raisedHands_ = new Set();
    recording_ = {
        active: false,
        recordingId: null,
    };
    state_;
    snapshot_;
    terminalError_ = null;
    leavePromise = null;
    expiresAt_ = null;
    publishBlocks = new Map();
    #control;
    constructor(localParticipant, snapshot, initialState, negotiated, control) {
        super();
        this.localParticipant = localParticipant;
        this.negotiated = negotiated;
        this.#control = control;
        this.snapshot_ = snapshot;
        for (const participant of snapshot.participants) {
            this.publishBlocks.set(participant.id, { ...participant.publishBlocked });
        }
        this.state_ = initialState;
        control.bind({
            snapshotChanged: (next) => this.installSnapshot(next),
            admitted: (next) => {
                this.installSnapshot(next);
                this.state_ = "admitted";
                this.emit("stateChanged", this.state_);
                this.emit("admitted");
            },
            denied: (next, error) => {
                this.snapshot_ = next;
                this.terminalError_ = error;
                this.state_ = "denied";
                this.emit("stateChanged", this.state_);
                this.emit("denied", error);
                this.emit("left");
            },
            failed: (error) => {
                this.terminalError_ = error;
                this.state_ = "failed";
                this.emit("stateChanged", this.state_);
                this.emit("error", error);
                if (error.context.reason !== "recovery_budget_exhausted")
                    this.emit("left");
            },
            connectionQualityChanged: (quality) => {
                this.emit("connectionQualityChanged", quality);
            },
            recovering: (state) => {
                this.state_ = state;
                this.emit("stateChanged", state);
            },
            recovered: (state, next) => {
                this.installSnapshot(next);
                this.state_ = state;
                this.terminalError_ = null;
                this.emit("stateChanged", state);
            },
            roomExpiring: (expiresAt) => {
                this.expiresAt_ = expiresAt;
                this.emit("roomExpiring", expiresAt);
            },
            remoteMicrophoneTrack: (track) => this.emit("remoteMicrophoneTrack", track),
            localMuteChanged: (publication, muted) => {
                this.emit("localMuteChanged", publication, muted);
            },
            roomMessage: (message) => this.emit("roomMessage", message),
            handRaisedChanged: (participantId, raised) => {
                // Tracked here rather than in the snapshot: adding a participant field to the
                // authoritative snapshot would break clients that parse it with an exact key set.
                const next = new Set(this.raisedHands_);
                if (raised)
                    next.add(participantId);
                else
                    next.delete(participantId);
                this.raisedHands_ = next;
                this.emit("handRaisedChanged", participantId, raised);
            },
            reactionReceived: (reaction) => this.emit("reactionReceived", reaction),
            recordingChanged: (active, recordingId) => {
                this.recording_ = { active, recordingId };
                this.emit("recordingChanged", active, recordingId);
            },
        });
    }
    /**
     * Participants whose hand is currently raised.
     *
     * Client-side state: raised hands travel as ephemeral events rather than snapshot fields, so
     * a participant who joins later sees only hands raised from that point on.
     */
    get raisedHands() {
        return this.raisedHands_;
    }
    /**
     * Whether the room is being recorded, and the recording identity while it is.
     *
     * Client-side state, like raised hands: recording travels as an event rather than a snapshot
     * field, so a participant who joins mid-recording learns of it only at the next change.
     */
    get recording() {
        return this.recording_;
    }
    /**
     * Start recording the room. Requires a host whose token carries controlRecording.
     *
     * Resolves with the recording identity. Retrying with the same `commandId` after an unknown
     * outcome is safe — the Public Edge derives the recording service's idempotency key from it.
     */
    startRecording(commandId) {
        return this.#control.setRecording(true, commandId);
    }
    /** Stop the room's recording. Any host may stop what another host started. */
    stopRecording(commandId) {
        return this.#control.setRecording(false, commandId).then(() => undefined);
    }
    /** Send a chat message to the room. Requires the token's sendMessages capability. */
    sendMessage(body) {
        this.#control.sendRoomMessage(body);
    }
    /** Raise or lower this participant's hand. Does not require sendMessages. */
    setHandRaised(raised) {
        this.#control.setHandRaised(raised);
    }
    /** Send a transient reaction. Requires the token's sendMessages capability. */
    sendReaction(reaction) {
        this.#control.sendReaction(reaction);
    }
    /** @internal Constructed only by the stable client attachment flow. */
    static create(localParticipant, snapshot, initialState, negotiated, control) {
        return new Conference(localParticipant, snapshot, initialState, negotiated, control);
    }
    /**
     * Capture and publish this participant's microphone.
     *
     * The returned identity is reserved by Hellave before WebRTC binding and is
     * stable across transport recovery.
     */
    async publishMicrophone(constraints = true, options) {
        if (this.state_ !== "admitted") {
            throw new HellaveError("conflict", "Conference is not admitted.");
        }
        if (!this.localParticipant.capabilities.publishAudio) {
            throw new HellaveError("authorization_denied", "Participant cannot publish audio.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
        const track = stream.getAudioTracks()[0];
        if (!track) {
            for (const captured of stream.getTracks())
                captured.stop();
            throw new HellaveError("invalid_request", "Microphone capture produced no audio track.");
        }
        try {
            const replaced = await this.#control.replaceMicrophoneTrack(track);
            if (replaced)
                return replaced;
            const publicationId = await this.#control.publishMicrophone(track, stream, options?.commandId);
            const publication = this.#control.localPublication(publicationId, this.localParticipant.id);
            return publication;
        }
        catch (error) {
            track.stop();
            throw error;
        }
    }
    get state() {
        return this.state_;
    }
    get snapshot() {
        return this.snapshot_;
    }
    /** Inactive stable publications retained for application-driven recovery. */
    get publicationIntents() {
        return this.#control.publicationIntents;
    }
    get terminalError() {
        return this.terminalError_;
    }
    /** Fixed terminal Room Instance expiry after the server announces it. */
    get expiresAt() {
        return this.expiresAt_;
    }
    /** Current spotlight video publication identity or null when cleared. */
    get spotlight() {
        return this.snapshot_.spotlightPublicationId;
    }
    /** Set or clear the room-wide Spotlight video publication. */
    setSpotlight(publicationId, options) {
        return this.#control.setSpotlight(publicationId, options?.commandId);
    }
    /** Retry control recovery explicitly after the configured Recovery Budget is exhausted. */
    retry() {
        return this.#control.retryRecovery();
    }
    deviceController_ = null;
    get mediaDeviceController() {
        if (!this.deviceController_) {
            const control = {
                publishCapture: (source, track, stream, callerCommandId) => this.#control.publishCapture(source, track, stream, callerCommandId),
                replacePublicationTrack: (publicationId, track) => this.#control.replacePublicationTrack(publicationId, track),
                getActiveSources: () => this.#control.getActiveSources(),
                ownsPublication: (id) => this.#control.ownsPublication(id),
                getLocalParticipantId: () => this.#control.getLocalParticipantId(),
            };
            this.deviceController_ = new MediaDeviceController(control);
        }
        return this.deviceController_;
    }
    get connectionQuality() {
        return this.#control.connectionQuality;
    }
    requestDiagnostics() {
        return this.#control.requestDiagnostics();
    }
    get roomId() {
        return this.snapshot_.roomId;
    }
    get roomInstanceId() {
        return this.snapshot_.roomInstanceId;
    }
    /** Admit one visible lobby participant and await the committed room revision. */
    admit(participantId, options) {
        const validation = this.validateLobbyCommand(participantId);
        if (validation)
            return Promise.reject(validation);
        return this.#control.command("admit", participantId, undefined, options?.commandId);
    }
    /** Deny one visible lobby participant and await the committed room revision. */
    deny(participantId, reason, options) {
        const validation = this.validateLobbyCommand(participantId);
        if (validation)
            return Promise.reject(validation);
        if (reason !== undefined && (reason.length === 0 || reason.length > 256)) {
            return Promise.reject(new HellaveError("invalid_request", "Lobby denial reason must be 1–256 characters."));
        }
        return this.#control.command("deny", participantId, reason, options?.commandId);
    }
    /** Apply or clear a server-enforced Publish Block without changing participant Local Mute. */
    setPublishBlock(participantId, mediaKind, blocked, options) {
        if (!this.localParticipant.capabilities.moderateParticipants) {
            return Promise.reject(new HellaveError("authorization_denied", "Participant cannot moderate Publish Block policy."));
        }
        return this.#control.setPublishBlock(participantId, mediaKind, blocked, options?.commandId);
    }
    /** Update the participant's private SFU subscription policy. */
    setSubscriptionPolicy(policy, options) {
        return this.#control.setSubscriptionPolicy({
            ...(policy.audioEnabled !== undefined && { audioEnabled: policy.audioEnabled }),
            ...(policy.videoEnabled !== undefined && { videoEnabled: policy.videoEnabled }),
            ...(policy.maxVideoConsumers !== undefined && { maxVideoConsumers: policy.maxVideoConsumers }),
            ...(policy.pinnedPublications !== undefined && { pinnedPublications: [...policy.pinnedPublications] }),
            ...(policy.preferredVideoLayer !== undefined && { preferredVideoLayer: policy.preferredVideoLayer }),
        }, options?.commandId);
    }
    /** Raise one or more publication IDs to high priority in the local subscription policy. */
    pin(...publicationIds) {
        return this.setSubscriptionPolicy({
            pinnedPublications: publicationIds,
        });
    }
    /** Remove publication priority preferences and reset to server-default subscription routing. */
    unpin() {
        return this.setSubscriptionPolicy({
            pinnedPublications: [],
        });
    }
    /**
     * Commit and acknowledge terminal membership leave, then close the attachment.
     * Repeated calls share one completion; a lost acknowledgement rejects as an unknown outcome.
     */
    leave() {
        if (this.leavePromise)
            return this.leavePromise;
        this.leavePromise = this.#control.leave().then(() => {
            if (this.state_ === "denied" || this.state_ === "left")
                return;
            this.state_ = "left";
            this.emit("stateChanged", this.state_);
            this.emit("left");
        });
        return this.leavePromise;
    }
    installSnapshot(next) {
        const previousPublicationIds = new Set(this.snapshot_.publications.map((publication) => publication.id));
        const previousSpotlight = this.snapshot_.spotlightPublicationId;
        this.snapshot_ = next;
        if (next.spotlightPublicationId !== previousSpotlight) {
            this.emit("spotlightChanged", next.spotlightPublicationId);
        }
        const currentParticipantIds = new Set();
        for (const participant of next.participants) {
            currentParticipantIds.add(participant.id);
            const previous = this.publishBlocks.get(participant.id) ?? { audio: false, video: false };
            if (previous.audio !== participant.publishBlocked.audio) {
                this.emit("publishBlockChanged", participant, "audio", participant.publishBlocked.audio);
            }
            if (previous.video !== participant.publishBlocked.video) {
                this.emit("publishBlockChanged", participant, "video", participant.publishBlocked.video);
            }
            this.publishBlocks.set(participant.id, { ...participant.publishBlocked });
        }
        for (const participantId of this.publishBlocks.keys()) {
            if (!currentParticipantIds.has(participantId))
                this.publishBlocks.delete(participantId);
        }
        this.emit("snapshotChanged", next);
        for (const publication of next.publications) {
            if (!previousPublicationIds.has(publication.id)) {
                this.emit("publicationAdded", publication);
            }
        }
    }
    validateLobbyCommand(participantId) {
        if (!this.localParticipant.capabilities.moderateLobby) {
            return new HellaveError("authorization_denied", "Participant cannot moderate the lobby.");
        }
        if (this.state_ !== "admitted") {
            return new HellaveError("conflict", "Conference is not admitted.");
        }
        if (participantId.length < 1 || participantId.length > 128) {
            return new HellaveError("invalid_request", "Lobby participant ID must be 1–128 characters.");
        }
        return null;
    }
}
//# sourceMappingURL=Conference.js.map