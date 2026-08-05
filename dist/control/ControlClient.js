import { CONTRACT_RELEASE, HellaveError, isHellaveErrorEnvelope, isProtocolCompatible, } from "../contracts.js";
import { LobbyParticipant } from "../domain/LobbyParticipant.js";
import { reconcileRoomParticipant, RoomParticipant, } from "../domain/RoomParticipant.js";
import { RoomSnapshot } from "../domain/RoomSnapshot.js";
import { SIMULCAST_ENCODINGS } from "../media/MediaManager.js";
import { RemoteMicrophoneTrack } from "../media/RemoteMicrophoneTrack.js";
import { RemoteVideoTrack } from "../media/RemoteVideoTrack.js";
import { bindPublicationOwner, markLocalMuted, markPublicationActive, markPublicationStopped, MediaPublication, } from "../media/MediaPublication.js";
/**
 * How long a transport waits for ICE servers before gathering without them.
 *
 * Long enough for a round trip to the Public Edge and its credential service, short enough that
 * an outage delays a join rather than preventing one.
 */
const ICE_SERVERS_WAIT_MS = 2_000;
/**
 * Ceiling for a screen share, matching the top camera layer.
 *
 * A screen share is one encoding, so there is no smaller layer for the SFU to drop to: unbounded, it
 * grows to fill the link and then starts losing packets, which takes the whole transport down with
 * it rather than degrading. Resolution is left alone on purpose — halving shared text to save
 * bandwidth makes it unreadable, which is worse than a lower frame rate.
 */
const SCREEN_SHARE_MAX_BITRATE = 1_500_000;
/**
 * What to pass as `sendEncodings` for a publication of this source, if anything.
 *
 * Returns a spreadable fragment rather than a value so the transceiver options stay unchanged for the
 * sources that want no encodings — passing `sendEncodings: undefined` is not the same as omitting it
 * in every browser.
 */
function encodingsForSource(source) {
    if (source === "camera")
        return { sendEncodings: [...SIMULCAST_ENCODINGS] };
    if (source === "screen")
        return { sendEncodings: [{ maxBitrate: SCREEN_SHARE_MAX_BITRATE }] };
    return {};
}
const SDK_NAME = "@hellave/js-sdk";
// Keep in step with packages/js/package.json: this is what the server sees in `hello`.
/**
 * Reported to the Public Edge in `hello`, and kept in step with package.json by the release check
 * below rather than by memory: it had drifted four versions behind, so every client in the field was
 * identifying itself as 0.5.15 and any behaviour correlated with SDK version was being read against
 * the wrong one.
 */
const SDK_VERSION = "0.5.20";
const WAITING_CAPABILITY = "waiting_conference";
const LOBBY_CAPABILITY = "lobby_admission";
const MICROPHONE_CAPABILITY = "microphone_publication";
const AUTHORITATIVE_STATE_CAPABILITY = "authoritative_room_state";
const ATTACHMENT_LIFECYCLE_CAPABILITY = "attachment_lifecycle";
const ROOM_INSTANCE_LIFECYCLE_CAPABILITY = "room_instance_lifecycle";
const BOUNDED_RECOVERY_CAPABILITY = "bounded_recovery";
const PUBLISH_BLOCK_POLICY_CAPABILITY = "publish_block_policy";
const ROOM_MESSAGING_CAPABILITY = "room_messaging";
const PARTICIPANT_SIGNALS_CAPABILITY = "participant_signals";
const RECORDING_CONTROL_CAPABILITY = "recording_control";
const SUBSCRIBER_TRANSPORT_CAPABILITY = "subscriber_transport";
/** Mirrors MAX_ROOM_MESSAGE_LEN on the Public Edge. */
const MAX_ROOM_MESSAGE_LEN = 2_000;
/** Mirrors SUPPORTED_REACTIONS on the Public Edge. */
const SUPPORTED_REACTIONS = new Set([
    "thumbs_up",
    "thumbs_down",
    "clap",
    "heart",
    "laugh",
    "surprised",
]);
let fallbackCommandSequence = 0;
/** Internal post-attachment transport. Media authority intentionally has no public accessor. */
/** @internal */
export class ControlSession {
    socket;
    canModerateLobby;
    serverCapabilities;
    timeoutMs;
    recoveryBudgetMs;
    recoverTransport;
    listener = null;
    pending = new Map();
    pendingPublications = new Map();
    activePublications = new Map();
    remotePublicationsByMid = new Map();
    participants = new Map();
    publications = new Map();
    publicationIntents_;
    peerConnection = null;
    activeMediaTransaction = null;
    /**
     * The transaction of an offer *we* sent and have not been answered for yet.
     *
     * Separate from activeMediaTransaction, which names whichever negotiation is current in either
     * direction. Without knowing the direction there is no way to notice that a server offer has
     * crossed one of ours: answering it overwrites activeMediaTransaction, and the answer to our own
     * offer then fails its identity check and terminates the attachment.
     */
    ownOfferTransaction = null;
    /** Woken when the offer above is answered, failed, or discarded. */
    ownOfferWaiters = [];
    /** Server offers dropped because one of ours was outstanding. Normal under contention. */
    crossedServerOffers = 0;
    activePublicationCommandId = null;
    pendingMediaAnswer = null;
    snapshotResyncPending = false;
    snapshotResyncTimeout = null;
    unknownCommands = new Set();
    pendingAdmissionRevision = null;
    mediaDescriptionSent = false;
    bufferedIceCandidates = [];
    snapshot_;
    state_;
    localParticipantId;
    attachedRevision;
    attachedState;
    terminalError = null;
    announcedExpiresAt = null;
    #mediaCapability;
    terminal = false;
    closedByCaller = false;
    recovery = null;
    recoveryController = null;
    recoveryExhausted = false;
    recoveryCause = "control";
    controlRecoveryRequested = false;
    mediaRecoveryRequested = false;
    pendingRecoveryAnswer = null;
    /**
     * The recording command awaiting its outcome.
     *
     * Recording is acknowledged by a `recording_state_changed` broadcast rather than by a
     * `command_accepted` carrying a revision, because it changes no room state and so has no
     * revision to report. Only one may be in flight, which is what makes correlating the next
     * state change with this command sound.
     */
    pendingRecording = null;
    lastIceServers = [];
    lastIceServersExpiresAt = 0;
    iceServersRefreshTimer = null;
    /** Resolvers for callers holding off a transport until ICE servers arrive. */
    iceServersWaiters = [];
    connectionQuality_ = "good";
    lastQualityUpdate = 0;
    /** Previous outbound byte count, so bitrate can be a rate rather than a running total. */
    lastBytesSent = 0;
    lastBytesSentAt = 0;
    qualityTimer = null;
    qualityPollIntervalMs = 2_000;
    mediaOperationGeneration = 0;
    leaving = false;
    leaveController = null;
    attachmentState;
    constructor(socket, snapshot, localParticipant, state, mediaCapability, publicationIntents, canModerateLobby, 
    /// Capabilities the Public Edge advertised in its welcome, so the client only uses a
    /// feature the server actually has.
    serverCapabilities, timeoutMs, recoveryBudgetMs, recoverTransport) {
        this.socket = socket;
        this.canModerateLobby = canModerateLobby;
        this.serverCapabilities = serverCapabilities;
        this.timeoutMs = timeoutMs;
        this.recoveryBudgetMs = recoveryBudgetMs;
        this.recoverTransport = recoverTransport;
        this.snapshot_ = snapshot;
        this.localParticipantId = localParticipant.id;
        this.participants.set(localParticipant.id, localParticipant);
        for (const participant of snapshot.participants) {
            this.participants.set(participant.id, participant);
        }
        for (const publication of snapshot.publications) {
            this.publications.set(publication.id, publication);
            if (publication.ownerParticipantId === localParticipant.id) {
                bindPublicationOwner(publication, this);
            }
        }
        this.publicationIntents_ = publicationIntents;
        for (const publication of publicationIntents) {
            this.publications.set(publication.id, publication);
            bindPublicationOwner(publication, this);
        }
        this.state_ = state;
        this.attachmentState = state;
        this.attachedRevision = snapshot.revision;
        this.attachedState = state;
        this.#mediaCapability = mediaCapability;
        if (state === "admitted") {
            // Attaching to a room you already belong to — creating one, or rejoining — arrives
            // admitted, so the later admission path never runs and the transport would never open.
            // Deferred so the caller has the session before anything is sent on its behalf.
            queueMicrotask(() => void this.openMediaTransport());
        }
    }
    /** @internal Participant identities retained across recovered attachments. */
    get participantRegistry() {
        return this.participants;
    }
    /** @internal Publication identities retained across recovered attachments. */
    get publicationRegistry() {
        return this.publications;
    }
    /** @internal Current room identity used for a recovered attachment. */
    get roomIdentity() {
        return Object.freeze({
            roomId: this.snapshot_.roomId,
            roomInstanceId: this.snapshot_.roomInstanceId,
        });
    }
    get connectionQuality() {
        return this.connectionQuality_;
    }
    bind(listener) {
        if (this.listener)
            throw new Error("ControlSession already has a listener");
        this.listener = listener;
        queueMicrotask(() => {
            if (this.listener !== listener)
                return;
            if (this.announcedExpiresAt !== null) {
                listener.roomExpiring(this.announcedExpiresAt);
            }
            if (this.state_ === "admitted" && this.attachedState === "waiting") {
                listener.admitted(this.snapshot_);
            }
            else if (this.state_ === "denied" && this.terminalError) {
                listener.denied(this.snapshot_, this.terminalError);
            }
            else if (this.state_ === "failed" && this.terminalError) {
                listener.failed(this.terminalError);
            }
            else if (this.snapshot_.revision > this.attachedRevision) {
                listener.snapshotChanged(this.snapshot_);
            }
        });
    }
    get publicationIntents() {
        return this.publicationIntents_;
    }
    /** Whether admitted media authority is currently retained by the internal session. */
    hasMediaCapability() {
        return this.#mediaCapability !== null;
    }
    command(action, participantId, reason, callerCommandId) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted") {
            return Promise.reject(new HellaveError("conflict", "Conference is not available for lobby moderation."));
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId)) {
            return Promise.reject(new HellaveError("invalid_request", "Room Command ID is invalid."));
        }
        if (this.pending.has(commandId) || this.pendingPublications.has(commandId)) {
            return Promise.reject(new HellaveError("conflict", "Room Command ID is already in flight.", { commandId }));
        }
        if (this.unknownCommands.has(commandId) && this.snapshotResyncPending) {
            return Promise.reject(new HellaveError("conflict", "Reconciliation must finish before retrying an unknown Room Command.", { commandId, outcome: "unknown" }));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(commandId);
                this.unknownCommands.add(commandId);
                this.requestSnapshotResync();
                reject(new HellaveError("temporarily_unavailable", "Room Command outcome is unknown; reconcile before retrying this command ID.", { commandId, outcome: "unknown" }));
            }, this.timeoutMs);
            this.pending.set(commandId, { resolve, reject, timeout });
            try {
                this.socket.send(JSON.stringify({
                    type: "lobby_command",
                    command_id: commandId,
                    action,
                    participant_id: participantId,
                    ...(reason === undefined ? {} : { reason }),
                }));
            }
            catch {
                this.pending.delete(commandId);
                clearTimeout(timeout);
                reject(new HellaveError("temporarily_unavailable", "Lobby command could not be sent."));
            }
        });
    }
    setPublishBlock(participantId, mediaKind, blocked, callerCommandId) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted") {
            return Promise.reject(new HellaveError("conflict", "Conference is not admitted."));
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId) || !isBoundedId(participantId)) {
            return Promise.reject(new HellaveError("invalid_request", "Publish Block command is invalid."));
        }
        if (this.pending.has(commandId) || this.pendingPublications.has(commandId)) {
            return Promise.reject(new HellaveError("conflict", "Room Command ID is already in flight.", { commandId }));
        }
        if (this.unknownCommands.has(commandId) && this.snapshotResyncPending) {
            return Promise.reject(new HellaveError("conflict", "Reconciliation must finish before retrying an unknown Room Command.", { commandId, outcome: "unknown" }));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(commandId);
                this.unknownCommands.add(commandId);
                this.requestSnapshotResync();
                reject(new HellaveError("temporarily_unavailable", "Publish Block outcome is unknown; reconcile before retrying.", { commandId, outcome: "unknown" }));
            }, this.timeoutMs);
            this.pending.set(commandId, { resolve, reject, timeout });
            try {
                this.socket.send(JSON.stringify({
                    type: "publish_block_command",
                    command_id: commandId,
                    participant_id: participantId,
                    media_kind: mediaKind,
                    blocked,
                }));
            }
            catch {
                this.pending.delete(commandId);
                clearTimeout(timeout);
                reject(new HellaveError("temporarily_unavailable", "Publish Block could not be sent."));
            }
        });
    }
    setSubscriptionPolicy(params, callerCommandId) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted") {
            return Promise.reject(new HellaveError("conflict", "Conference is not admitted."));
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId)) {
            return Promise.reject(new HellaveError("invalid_request", "Room Command ID is invalid."));
        }
        if (this.pending.has(commandId) || this.pendingPublications.has(commandId)) {
            return Promise.reject(new HellaveError("conflict", "Room Command ID is already in flight.", { commandId }));
        }
        if (this.unknownCommands.has(commandId) && this.snapshotResyncPending) {
            return Promise.reject(new HellaveError("conflict", "Reconciliation must finish before retrying an unknown Room Command.", { commandId, outcome: "unknown" }));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(commandId);
                this.unknownCommands.add(commandId);
                this.requestSnapshotResync();
                reject(new HellaveError("temporarily_unavailable", "Subscription Policy outcome is unknown; reconcile before retrying.", { commandId, outcome: "unknown" }));
            }, this.timeoutMs);
            this.pending.set(commandId, { resolve, reject, timeout });
            try {
                this.socket.send(JSON.stringify({
                    type: "set_subscription_policy",
                    command_id: commandId,
                    ...(params.audioEnabled !== undefined && { audio_enabled: params.audioEnabled }),
                    ...(params.videoEnabled !== undefined && { video_enabled: params.videoEnabled }),
                    ...(params.maxVideoConsumers !== undefined && { max_video_consumers: params.maxVideoConsumers }),
                    ...(params.pinnedPublications !== undefined && { pinned_publications: params.pinnedPublications }),
                    ...(params.preferredVideoLayer !== undefined && { preferred_video_layer: params.preferredVideoLayer }),
                }));
            }
            catch {
                this.pending.delete(commandId);
                clearTimeout(timeout);
                reject(new HellaveError("temporarily_unavailable", "Subscription Policy could not be sent."));
            }
        });
    }
    setSpotlight(publicationId, callerCommandId) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted") {
            return Promise.reject(new HellaveError("conflict", "Conference is not admitted."));
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId)) {
            return Promise.reject(new HellaveError("invalid_request", "Room Command ID is invalid."));
        }
        if (this.pending.has(commandId) || this.pendingPublications.has(commandId)) {
            return Promise.reject(new HellaveError("conflict", "Room Command ID is already in flight.", { commandId }));
        }
        if (this.unknownCommands.has(commandId) && this.snapshotResyncPending) {
            return Promise.reject(new HellaveError("conflict", "Reconciliation must finish before retrying an unknown Room Command.", { commandId, outcome: "unknown" }));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(commandId);
                this.unknownCommands.add(commandId);
                this.requestSnapshotResync();
                reject(new HellaveError("temporarily_unavailable", "Set Spotlight outcome is unknown; reconcile before retrying.", { commandId, outcome: "unknown" }));
            }, this.timeoutMs);
            this.pending.set(commandId, { resolve, reject, timeout });
            try {
                this.socket.send(JSON.stringify({
                    type: "set_spotlight",
                    command_id: commandId,
                    publication_id: publicationId ?? "",
                }));
            }
            catch {
                this.pending.delete(commandId);
                clearTimeout(timeout);
                reject(new HellaveError("temporarily_unavailable", "Set Spotlight could not be sent."));
            }
        });
    }
    publishMicrophone(track, stream, callerCommandId) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted"
            || !this.#mediaCapability) {
            return Promise.reject(new HellaveError("conflict", "Conference media is unavailable."));
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId)) {
            return Promise.reject(new HellaveError("invalid_request", "Room Command ID is invalid."));
        }
        if (this.pending.has(commandId) || this.pendingPublications.has(commandId)) {
            return Promise.reject(new HellaveError("conflict", "Room Command ID is already in flight.", { commandId }));
        }
        if (this.unknownCommands.has(commandId) && this.snapshotResyncPending) {
            return Promise.reject(new HellaveError("conflict", "Reconciliation must finish before retrying an unknown Room Command.", { commandId, outcome: "unknown" }));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingPublications.delete(commandId);
                this.unknownCommands.add(commandId);
                this.requestSnapshotResync();
                reject(new HellaveError("temporarily_unavailable", "Publication outcome is unknown; reconcile before retrying this command ID.", { commandId, outcome: "unknown" }));
            }, this.timeoutMs);
            this.pendingPublications.set(commandId, {
                track,
                stream,
                source: "microphone",
                reuseSender: false,
                stopTrackOnFailure: true,
                resolve,
                reject,
                timeout,
            });
            try {
                this.socket.send(JSON.stringify({
                    type: "publication_reserve",
                    command_id: commandId,
                    source: "microphone",
                }));
            }
            catch {
                this.pendingPublications.delete(commandId);
                clearTimeout(timeout);
                reject(new HellaveError("temporarily_unavailable", "Publication could not be sent."));
            }
        });
    }
    /** @internal Replace the captured track without replacing publication identity. */
    async replaceMicrophoneTrack(track) {
        const active = this.activePublications.entries().next().value;
        if (!active)
            return null;
        const [publicationId, binding] = active;
        const publication = this.publications.get(publicationId);
        if (!publication) {
            throw new HellaveError("internal", "Active microphone publication identity is unavailable.");
        }
        if (publication.localMuted)
            track.enabled = false;
        await binding.sender.replaceTrack(track);
        binding.track.stop();
        this.activePublications.set(publicationId, {
            track,
            stream: binding.stream,
            sender: binding.sender,
        });
        return publication;
    }
    /** @internal Publish a captured track by source type. */
    publishCapture(source, track, stream, callerCommandId) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted" || !this.#mediaCapability) {
            return Promise.reject(new HellaveError("conflict", "Conference media is unavailable."));
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId)) {
            return Promise.reject(new HellaveError("invalid_request", "Room Command ID is invalid."));
        }
        if (this.pending.has(commandId) || this.pendingPublications.has(commandId)) {
            return Promise.reject(new HellaveError("conflict", "Room Command ID is already in flight.", { commandId }));
        }
        if (this.unknownCommands.has(commandId) && this.snapshotResyncPending) {
            return Promise.reject(new HellaveError("conflict", "Reconciliation must finish before retrying an unknown Room Command.", { commandId, outcome: "unknown" }));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingPublications.delete(commandId);
                this.unknownCommands.add(commandId);
                this.requestSnapshotResync();
                reject(new HellaveError("temporarily_unavailable", "Publication outcome is unknown; reconcile before retrying this command ID.", { commandId, outcome: "unknown" }));
            }, this.timeoutMs);
            this.pendingPublications.set(commandId, {
                track,
                stream,
                source,
                reuseSender: false,
                stopTrackOnFailure: true,
                resolve,
                reject,
                timeout,
            });
            try {
                this.socket.send(JSON.stringify({ type: "publication_reserve", command_id: commandId, source }));
            }
            catch {
                this.pendingPublications.delete(commandId);
                clearTimeout(timeout);
                reject(new HellaveError("temporarily_unavailable", "Publication could not be sent."));
            }
        });
    }
    /** @internal Replace the track behind any active publication. Returns true on success. */
    async replacePublicationTrack(publicationId, track) {
        const activePub = this.activePublications.get(publicationId);
        if (!activePub)
            return false;
        const publication = this.publications.get(publicationId);
        if (!publication || publication.ownerParticipantId !== this.localParticipantId)
            return false;
        if (publication.localMuted)
            track.enabled = false;
        try {
            await activePub.sender.replaceTrack(track);
        }
        catch {
            return false;
        }
        activePub.track.stop();
        this.activePublications.set(publicationId, { track, stream: activePub.stream, sender: activePub.sender });
        return true;
    }
    /** @internal Current active publications mapped by source type. */
    getActiveSources() {
        const result = {};
        for (const [publicationId] of this.activePublications) {
            const publication = this.publications.get(publicationId);
            if (!publication)
                continue;
            switch (publication.source) {
                case "microphone":
                    result.microphone = publication;
                    break;
                case "camera":
                    result.camera = publication;
                    break;
                case "screen":
                    result.screen = publication;
                    break;
                case "screen_audio":
                    result.screenAudio = publication;
                    break;
            }
        }
        return result;
    }
    /** @internal Local participant identity. */
    getLocalParticipantId() {
        return this.localParticipantId;
    }
    /** @internal Whether the local participant owns a publication by ID. */
    ownsPublication(publicationId) {
        const publication = this.publications.get(publicationId);
        return publication?.ownerParticipantId === this.localParticipantId;
    }
    /** @internal Return the stable authoritative publication object for a local source. */
    localPublication(publicationId, ownerParticipantId, source = "microphone") {
        let publication = this.publications.get(publicationId);
        if (!publication) {
            publication = new MediaPublication(publicationId, ownerParticipantId, source);
            this.publications.set(publicationId, publication);
        }
        bindPublicationOwner(publication, this);
        return publication;
    }
    async unpublish(publicationId, callerCommandId) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted") {
            throw new HellaveError("conflict", "Conference media is unavailable.");
        }
        const binding = this.activePublications.get(publicationId);
        const publication = this.publications.get(publicationId);
        if (!binding && publication?.ownerParticipantId !== this.localParticipantId) {
            throw new HellaveError("authorization_denied", "Only the owning participant can stop this publication.");
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId)) {
            throw new HellaveError("invalid_request", "Room Command ID is invalid.");
        }
        if (this.pending.has(commandId) || this.pendingPublications.has(commandId)) {
            throw new HellaveError("conflict", "Room Command ID is already in flight.", { commandId });
        }
        if (this.unknownCommands.has(commandId) && this.snapshotResyncPending) {
            throw new HellaveError("conflict", "Reconciliation must finish before retrying an unknown Room Command.", { commandId, outcome: "unknown" });
        }
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(commandId);
                this.unknownCommands.add(commandId);
                this.requestSnapshotResync();
                reject(new HellaveError("temporarily_unavailable", "Publication stop outcome is unknown; reconcile before retrying this command ID.", { commandId, outcome: "unknown" }));
            }, this.timeoutMs);
            this.pending.set(commandId, {
                timeout,
                resolve: () => resolve(),
                reject,
            });
            try {
                this.socket.send(JSON.stringify({
                    type: "publication_stop",
                    command_id: commandId,
                    publication_id: publicationId,
                }));
            }
            catch {
                this.pending.delete(commandId);
                clearTimeout(timeout);
                reject(new HellaveError("temporarily_unavailable", "Publication stop could not be sent."));
            }
        });
        if (binding && this.peerConnection) {
            this.peerConnection.removeTrack(binding.sender);
            binding.track.stop();
        }
        this.activePublications.delete(publicationId);
    }
    setLocalMute(publicationId, muted) {
        const binding = this.activePublications.get(publicationId);
        const publication = this.publications.get(publicationId);
        if (!binding || !publication || publication.ownerParticipantId !== this.localParticipantId) {
            throw new HellaveError("authorization_denied", "Local Mute requires an owned publication.");
        }
        binding.track.enabled = !muted;
        markLocalMuted(publication, muted);
        this.listener?.localMuteChanged(publication, muted);
    }
    async leave(callerCommandId) {
        if (this.closedByCaller || this.leaving)
            return;
        this.leaving = true;
        if (this.recoveryExhausted)
            this.terminal = false;
        this.recoveryController?.abort();
        await this.recovery?.catch(() => { });
        if (this.socket.readyState !== WebSocket.OPEN) {
            const controller = new AbortController();
            this.leaveController = controller;
            const deadline = Date.now() + this.recoveryBudgetMs;
            try {
                await this.recoverTransport(this, controller.signal, deadline);
            }
            catch (error) {
                if (this.leaveController === controller)
                    this.leaveController = null;
                this.leaving = false;
                throw error;
            }
            if (this.leaveController === controller)
                this.leaveController = null;
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId)) {
            throw new HellaveError("invalid_request", "Room Command ID is invalid.");
        }
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pending.delete(commandId);
                    reject(new HellaveError("temporarily_unavailable", "Explicit leave outcome is unknown.", { commandId, outcome: "unknown" }));
                }, this.timeoutMs);
                this.pending.set(commandId, { timeout, resolve, reject });
                try {
                    this.socket.send(JSON.stringify({ type: "leave", command_id: commandId }));
                }
                catch {
                    this.pending.delete(commandId);
                    clearTimeout(timeout);
                    reject(new HellaveError("temporarily_unavailable", "Explicit leave could not be sent."));
                }
            });
        }
        finally {
            this.leaving = false;
        }
    }
    close() {
        if (this.closedByCaller)
            return;
        this.closedByCaller = true;
        this.recoveryController?.abort();
        this.leaveController?.abort();
        this.rejectPending(new HellaveError("request_cancelled", "Conference attachment closed."));
        if (this.socket.readyState === WebSocket.OPEN
            || this.socket.readyState === WebSocket.CONNECTING) {
            this.socket.close();
        }
        this.#mediaCapability = null;
        this.closeMedia();
    }
    handleMessage(message, sourceSocket = this.socket) {
        if (sourceSocket !== this.socket || this.terminal || this.closedByCaller)
            return;
        if (message.type === "room_delta") {
            if (!hasExactKeys(message, ["type", "delta"]) || !isRecord(message.delta)) {
                this.failInvalidMessage();
                return;
            }
            if (this.snapshotResyncPending
                || !isRevision(message.delta.base_revision)
                || !isRevision(message.delta.revision)
                || message.delta.base_revision !== this.snapshot_.revision
                || message.delta.revision !== this.snapshot_.revision + 1) {
                this.requestSnapshotResync();
                return;
            }
            const next = parseDelta(message.delta, this.snapshot_, this.canModerateLobby, this.participants, this.publications);
            if (next instanceof HellaveError) {
                this.terminateFailed(next);
            }
            else {
                this.installCommittedSnapshot(next);
            }
            return;
        }
        if (message.type === "room_snapshot") {
            if (!hasExactKeys(message, ["type", "snapshot"])
                || !isRecord(message.snapshot)
                || !isRevision(message.snapshot.revision)) {
                this.failInvalidMessage();
                return;
            }
            const revision = message.snapshot.revision;
            if (!this.snapshotResyncPending && revision !== this.snapshot_.revision + 1) {
                this.requestSnapshotResync();
                return;
            }
            if (this.snapshotResyncPending && revision < this.snapshot_.revision) {
                this.requestSnapshotResync();
                return;
            }
            if (this.snapshotResyncPending && revision === this.snapshot_.revision) {
                const confirmation = parseSnapshot(message.snapshot, this.snapshot_.roomId, this.snapshot_.roomInstanceId, this.canModerateLobby);
                if (confirmation instanceof HellaveError
                    || !snapshotsEquivalent(confirmation, this.snapshot_)) {
                    this.terminateFailed(confirmation instanceof HellaveError
                        ? confirmation
                        : new HellaveError("invalid_request", "Snapshot confirmation changed state without advancing its revision."));
                    return;
                }
                this.clearSnapshotResync();
                return;
            }
            const next = parseSnapshot(message.snapshot, this.snapshot_.roomId, this.snapshot_.roomInstanceId, this.canModerateLobby, this.participants, this.publications);
            if (next instanceof HellaveError) {
                this.terminateFailed(next);
            }
            else if (next.revision >= this.snapshot_.revision) {
                this.clearSnapshotResync();
                this.installCommittedSnapshot(next);
            }
            return;
        }
        if (message.type === "command_result") {
            if (!hasExactKeys(message, ["type", "command_id", "revision"])
                || !isBoundedId(message.command_id)
                || !isRevision(message.revision)) {
                this.failInvalidMessage();
                return;
            }
            const pending = this.pending.get(message.command_id);
            if (!pending)
                return;
            this.pending.delete(message.command_id);
            clearTimeout(pending.timeout);
            this.unknownCommands.delete(message.command_id);
            pending.resolve(Object.freeze({
                commandId: message.command_id,
                revision: message.revision,
            }));
            if (message.revision !== this.snapshot_.revision)
                this.requestSnapshotResync();
            return;
        }
        if (message.type === "left") {
            if (!hasExactKeys(message, ["type", "command_id", "revision"])
                || !isBoundedId(message.command_id)
                || !isRevision(message.revision)) {
                this.failInvalidMessage();
                return;
            }
            const pending = this.pending.get(message.command_id);
            if (!pending)
                return;
            this.pending.delete(message.command_id);
            clearTimeout(pending.timeout);
            pending.resolve(Object.freeze({
                commandId: message.command_id,
                revision: message.revision,
            }));
            this.closedByCaller = true;
            this.#mediaCapability = null;
            this.closeMedia();
            this.closeSocketOnly();
            return;
        }
        if (message.type === "publication_reserved") {
            if (!hasExactKeys(message, [
                "type", "command_id", "publication_id", "revision", "ice_servers", "ttl_secs",
            ])
                || !isBoundedId(message.command_id)
                || !isBoundedId(message.publication_id)
                || !isRevision(message.revision)
                || !isIceServers(message.ice_servers)
                || !isNonNegativeFinite(message.ttl_secs)) {
                this.failInvalidMessage();
                return;
            }
            this.updateIceServers(message.ice_servers, message.ttl_secs);
            const pending = this.pendingPublications.get(message.command_id);
            if (!pending)
                return;
            void this.beginPublicationNegotiation(message.command_id, message.publication_id, message.ice_servers, pending);
            return;
        }
        if (message.type === "ice_servers_updated") {
            if (!hasExactKeys(message, ["type", "ice_servers", "ttl_secs"])
                || !isIceServers(message.ice_servers)
                || !isNonNegativeFinite(message.ttl_secs)) {
                this.failInvalidMessage();
                return;
            }
            this.updateIceServers(message.ice_servers, message.ttl_secs);
            return;
        }
        if (message.type === "media_answer") {
            if (!hasExactKeys(message, ["type", "transaction_id", "sdp"])
                || !isBoundedId(message.transaction_id)
                || message.transaction_id !== this.activeMediaTransaction
                || typeof message.sdp !== "string"
                || message.sdp.length < 1
                || message.sdp.length > 1_000_000
                || !this.peerConnection) {
                this.failInvalidMessage();
                return;
            }
            const transactionId = message.transaction_id;
            if (this.ownOfferTransaction === transactionId) {
                // Answered, so a server offer arriving now is no longer a crossing and is handled normally.
                this.releaseOwnOffer();
            }
            const application = this.peerConnection
                .setRemoteDescription({ type: "answer", sdp: message.sdp });
            this.pendingMediaAnswer = { transactionId, application };
            void application
                .then(() => {
                const recovery = this.pendingRecoveryAnswer;
                if (recovery?.transactionId === transactionId) {
                    clearTimeout(recovery.timeout);
                    this.pendingRecoveryAnswer = null;
                    recovery.resolve();
                }
            })
                .catch(() => {
                const recovery = this.pendingRecoveryAnswer;
                if (recovery?.transactionId === transactionId) {
                    clearTimeout(recovery.timeout);
                    this.pendingRecoveryAnswer = null;
                    recovery.reject(new HellaveError("temporarily_unavailable", "Media recovery answer failed."));
                }
                else {
                    this.failMediaTransaction(this.activePublicationCommandId ?? undefined);
                }
            });
            return;
        }
        if (message.type === "media_recovery_rejected") {
            if (!hasExactKeys(message, ["type", "transaction_id", "error"])
                || !isBoundedId(message.transaction_id)) {
                this.failInvalidMessage();
                return;
            }
            const recovery = this.pendingRecoveryAnswer;
            const error = parseErrorEnvelope(message.error);
            if (!recovery || recovery.transactionId !== message.transaction_id || !error) {
                this.failInvalidMessage();
                return;
            }
            clearTimeout(recovery.timeout);
            this.pendingRecoveryAnswer = null;
            recovery.reject(error);
            return;
        }
        if (message.type === "media_offer") {
            if (!hasExactKeys(message, ["type", "transaction_id", "sdp"])
                || !isBoundedId(message.transaction_id)
                || typeof message.sdp !== "string"
                || message.sdp.length < 1
                || message.sdp.length > 1_000_000
                || !this.peerConnection) {
                this.failInvalidMessage();
                return;
            }
            // Glare: this offer crossed one of ours on the wire, so neither side caused the other and the
            // Public Edge could not have known. Dropped rather than answered — the SFU resolves glare in
            // our favour by accepting our offer, which discards the very offer being delivered here, so
            // answering it would apply a description the far end has already abandoned. It reoffers once
            // this transaction settles.
            //
            // Answering it also used to be fatal in a way that had nothing to do with SDP:
            // answerServerOffer overwrites activeMediaTransaction, and the answer to our own offer then
            // failed its identity check and terminated the attachment.
            if (this.ownOfferTransaction !== null) {
                this.crossedServerOffers += 1;
                return;
            }
            void this.answerServerOffer(message.transaction_id, message.sdp);
            return;
        }
        if (message.type === "media_ice") {
            if (!hasExactKeys(message, ["type", "transaction_id", "candidate"])
                || !isBoundedId(message.transaction_id)
                || !isIceCandidate(message.candidate)
                || !this.peerConnection) {
                this.failInvalidMessage();
                return;
            }
            void this.peerConnection.addIceCandidate(message.candidate).catch(() => {
                this.failMediaTransaction(this.activePublicationCommandId ?? undefined);
            });
            return;
        }
        if (message.type === "publication_active") {
            if (!hasExactKeys(message, ["type", "command_id", "publication_id", "revision"])
                || !isBoundedId(message.command_id)
                || !isBoundedId(message.publication_id)
                || !isRevision(message.revision)) {
                this.failInvalidMessage();
                return;
            }
            void this.activatePublication(message.command_id, message.publication_id, message.revision);
            return;
        }
        if (message.type === "publication_available") {
            if (!hasExactKeys(message, [
                "type", "publication_id", "owner_participant_id", "mid",
            ])
                || !isBoundedId(message.publication_id)
                || !isBoundedId(message.owner_participant_id)
                || !isBoundedId(message.mid)) {
                this.failInvalidMessage();
                return;
            }
            this.remotePublicationsByMid.set(message.mid, {
                publicationId: message.publication_id,
                ownerParticipantId: message.owner_participant_id,
            });
            return;
        }
        if (message.type === "command_rejected") {
            if (!hasExactKeys(message, ["type", "command_id", "error"])
                || !isBoundedId(message.command_id)) {
                this.failInvalidMessage();
                return;
            }
            const error = parseErrorEnvelope(message.error);
            if (!error) {
                this.failInvalidMessage();
                return;
            }
            if (this.pendingRecording?.commandId === message.command_id) {
                const recording = this.pendingRecording;
                this.pendingRecording = null;
                clearTimeout(recording.timeout);
                recording.reject(error);
                return;
            }
            const pending = this.pending.get(message.command_id);
            if (pending) {
                this.pending.delete(message.command_id);
                clearTimeout(pending.timeout);
                this.unknownCommands.delete(message.command_id);
                pending.reject(error);
                return;
            }
            const publication = this.pendingPublications.get(message.command_id);
            if (publication) {
                this.pendingPublications.delete(message.command_id);
                clearTimeout(publication.timeout);
                this.unknownCommands.delete(message.command_id);
                if (publication.stopTrackOnFailure)
                    publication.track.stop();
                publication.reject(error);
            }
            return;
        }
        if (message.type === "admitted") {
            if (this.state_ !== "waiting"
                || !hasExactKeys(message, ["type", "revision", "media_capability"])
                || !isRevision(message.revision)
                || message.revision <= this.snapshot_.revision
                || !isMediaCapability(message.media_capability)) {
                this.failInvalidMessage();
                return;
            }
            this.#mediaCapability = {
                token: message.media_capability.token,
                expiresAt: message.media_capability.expires_at,
            };
            this.pendingAdmissionRevision = message.revision;
            this.requestSnapshotResync();
            return;
        }
        if (message.type === "denied") {
            if (this.state_ !== "waiting"
                || !hasExactKeys(message, ["type", "revision", "error"])
                || !isRevision(message.revision)
                || message.revision <= this.snapshot_.revision) {
                this.failInvalidMessage();
                return;
            }
            const error = parseErrorEnvelope(message.error);
            if (!error || error.code !== "authorization_denied") {
                this.failInvalidMessage();
                return;
            }
            this.state_ = "denied";
            this.terminal = true;
            this.terminalError = error;
            this.#mediaCapability = null;
            this.rejectPending(error);
            this.listener?.denied(this.snapshot_, error);
            this.closeSocketOnly();
            return;
        }
        if (message.type === "room_expiring") {
            if (!hasExactKeys(message, ["type", "expires_at"])
                || !Number.isSafeInteger(message.expires_at)
                || message.expires_at <= 0) {
                this.failInvalidMessage();
                return;
            }
            this.announcedExpiresAt = message.expires_at;
            this.listener?.roomExpiring(this.announcedExpiresAt);
            return;
        }
        if (message.type === "room_ended") {
            if (!hasExactKeys(message, ["type", "reason", "revision"])
                || (message.reason !== "expired" && message.reason !== "destroyed")
                || !isRevision(message.revision)) {
                this.failInvalidMessage();
                return;
            }
            this.terminateFailed(new HellaveError("resource_not_found", `Room Instance ${message.reason}.`, { reason: message.reason, revision: message.revision }));
            return;
        }
        if (message.type === "control_error") {
            if (!hasExactKeys(message, ["type", "error"])) {
                this.failInvalidMessage();
                return;
            }
            const error = parseErrorEnvelope(message.error);
            if (error)
                this.terminateFailed(error);
            else
                this.failInvalidMessage();
            return;
        }
        if (message.type === "room_message") {
            if (!hasExactKeys(message, ["type", "from_participant_id", "body", "sent_at"])
                || !isBoundedId(message.from_participant_id)
                || typeof message.body !== "string"
                || !isRevision(message.sent_at)) {
                this.failInvalidMessage();
                return;
            }
            this.listener?.roomMessage({
                fromParticipantId: message.from_participant_id,
                body: message.body,
                sentAt: message.sent_at,
            });
            return;
        }
        if (message.type === "hand_raised_changed") {
            if (!hasExactKeys(message, ["type", "participant_id", "raised"])
                || !isBoundedId(message.participant_id)
                || typeof message.raised !== "boolean") {
                this.failInvalidMessage();
                return;
            }
            this.listener?.handRaisedChanged(message.participant_id, message.raised);
            return;
        }
        if (message.type === "recording_state_changed") {
            if (!hasExactKeys(message, ["type", "active", "recording_id"])
                && !hasExactKeys(message, ["type", "active"])) {
                this.failInvalidMessage();
                return;
            }
            const recordingId = message.recording_id ?? null;
            if (typeof message.active !== "boolean"
                || (recordingId !== null && !isBoundedId(recordingId))) {
                this.failInvalidMessage();
                return;
            }
            // The initiator is answered with this same message, so it doubles as the command
            // outcome; everyone else simply learns the room is being recorded.
            if (this.pendingRecording) {
                const pending = this.pendingRecording;
                this.pendingRecording = null;
                clearTimeout(pending.timeout);
                pending.resolve(recordingId);
            }
            this.listener?.recordingChanged(message.active, recordingId);
            return;
        }
        if (message.type === "reaction_received") {
            if (!hasExactKeys(message, ["type", "from_participant_id", "reaction", "sent_at"])
                || !isBoundedId(message.from_participant_id)
                || typeof message.reaction !== "string"
                || !isRevision(message.sent_at)) {
                this.failInvalidMessage();
                return;
            }
            this.listener?.reactionReceived({
                fromParticipantId: message.from_participant_id,
                reaction: message.reaction,
                sentAt: message.sent_at,
            });
            return;
        }
        this.failInvalidMessage();
    }
    /**
     * Send an ephemeral room event.
     *
     * These carry no command_id and receive no acknowledgement: the Public Edge broadcasts them
     * or rejects them with a control error, so there is no outcome to reconcile.
     */
    sendEphemeral(payload, description) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted") {
            throw new HellaveError("conflict", `${description} requires an admitted attachment.`);
        }
        try {
            this.socket.send(JSON.stringify(payload));
        }
        catch {
            throw new HellaveError("temporarily_unavailable", `${description} could not be sent.`);
        }
    }
    /**
     * Ask the Public Edge to start or stop recording this room.
     *
     * Resolves with the recording identity once running, or null once stopped. Unlike the
     * ephemeral sends, this is a command: it is refused per-command rather than fatally, so a
     * rejection leaves the conference intact.
     */
    setRecording(active, callerCommandId) {
        if (this.terminal || this.closedByCaller || this.state_ !== "admitted") {
            return Promise.reject(new HellaveError("conflict", "Conference is not admitted."));
        }
        const commandId = callerCommandId ?? createCommandId();
        if (!isBoundedId(commandId)) {
            return Promise.reject(new HellaveError("invalid_request", "Room Command ID is invalid."));
        }
        if (this.pendingRecording) {
            return Promise.reject(new HellaveError("conflict", "A recording command is already in flight.", { commandId: this.pendingRecording.commandId }));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRecording = null;
                // Retrying with the same command id is safe: the Public Edge derives the recording
                // service's idempotency key from it, so a retry cannot start a second recording.
                reject(new HellaveError("temporarily_unavailable", "Recording outcome is unknown; retry with the same command id.", { commandId, outcome: "unknown" }));
            }, this.timeoutMs);
            this.pendingRecording = { commandId, resolve, reject, timeout };
            try {
                this.socket.send(JSON.stringify({
                    type: "recording_command",
                    command_id: commandId,
                    active,
                }));
            }
            catch {
                this.pendingRecording = null;
                clearTimeout(timeout);
                reject(new HellaveError("temporarily_unavailable", "Recording command could not be sent."));
            }
        });
    }
    sendRoomMessage(body) {
        // Validated here because the Public Edge answers a malformed ephemeral send with a
        // control_error, which is fatal by contract. A user typing one character too many must
        // not end the call, so the bound is enforced before anything reaches the wire.
        if (body.length === 0 || body.length > MAX_ROOM_MESSAGE_LEN) {
            throw new HellaveError("invalid_request", `Chat message must be between 1 and ${MAX_ROOM_MESSAGE_LEN} characters.`);
        }
        this.sendEphemeral({ type: "send_room_message", body }, "Chat message");
    }
    setHandRaised(raised) {
        this.sendEphemeral({ type: "set_hand_raised", raised }, "Hand raise");
    }
    sendReaction(reaction) {
        if (!SUPPORTED_REACTIONS.has(reaction)) {
            throw new HellaveError("invalid_request", `Unsupported reaction "${reaction}".`);
        }
        this.sendEphemeral({ type: "send_reaction", reaction }, "Reaction");
    }
    installCommittedSnapshot(next) {
        this.snapshot_ = next;
        if (this.pendingAdmissionRevision !== null
            && next.revision >= this.pendingAdmissionRevision) {
            this.pendingAdmissionRevision = null;
            this.state_ = "admitted";
            this.attachmentState = "admitted";
            this.listener?.admitted(next);
            // An admitted attachment needs a transport before the Public Edge has anywhere to send
            // the room's media. Publishing used to be the only thing that created one, so a
            // participant who joined to listen never received anything.
            void this.openMediaTransport();
            return;
        }
        this.listener?.snapshotChanged(next);
    }
    handleTransportFailure(failedSocket = this.socket) {
        if (failedSocket !== this.socket || this.terminal || this.closedByCaller || this.leaving) {
            return;
        }
        this.controlRecoveryRequested = true;
        this.rejectPendingAsUnknown();
        if (this.recovery)
            return;
        void this.startRecovery().catch(() => { });
    }
    /** @internal Install a newly authenticated control attachment without replacing SDK objects. */
    installRecoveredTransport(socket, attachment) {
        if (attachment instanceof HellaveError)
            return attachment;
        if (attachment.participant.id !== this.localParticipantId) {
            return new HellaveError("authorization_denied", "Recovered attachment changed participant identity.");
        }
        if (attachment.snapshot.revision < this.snapshot_.revision) {
            return new HellaveError("conflict", "Recovered attachment regressed the authoritative Room Revision.", { knownRevision: this.snapshot_.revision, receivedRevision: attachment.snapshot.revision });
        }
        if (attachment.snapshot.revision === this.snapshot_.revision
            && snapshotFingerprint(attachment.snapshot) !== snapshotFingerprint(this.snapshot_)) {
            return new HellaveError("conflict", "Recovered attachment contradicted the known authoritative Room Revision.", { revision: attachment.snapshot.revision });
        }
        const localParticipant = this.participants.get(this.localParticipantId);
        if (!localParticipant) {
            return new HellaveError("invalid_request", "Local participant registry is incomplete.");
        }
        reconcileRoomParticipant(localParticipant, attachment.participant.profile, attachment.participant.role, attachment.participant.capabilities, attachment.participant.muted, attachment.participant.publishBlocked);
        const participants = attachment.snapshot.participants.map((incoming) => {
            const existing = this.participants.get(incoming.id);
            if (!existing) {
                this.participants.set(incoming.id, incoming);
                return incoming;
            }
            reconcileRoomParticipant(existing, incoming.profile, incoming.role, incoming.capabilities, incoming.muted, incoming.publishBlocked);
            return existing;
        });
        const publications = attachment.snapshot.publications.map((incoming) => {
            const existing = this.publications.get(incoming.id) ?? incoming;
            this.publications.set(incoming.id, existing);
            markPublicationActive(existing);
            if (existing.ownerParticipantId === this.localParticipantId) {
                bindPublicationOwner(existing, this);
            }
            return existing;
        });
        const activeIds = new Set(publications.map((publication) => publication.id));
        const publicationIntents = attachment.publicationIntents.flatMap((incoming) => {
            const existing = this.publications.get(incoming.id) ?? incoming;
            this.publications.set(incoming.id, existing);
            if (activeIds.has(existing.id) && this.activePublications.has(existing.id))
                return [];
            if (!activeIds.has(existing.id))
                markPublicationStopped(existing);
            return [existing];
        });
        const reconciledSnapshot = new RoomSnapshot(attachment.snapshot.revision, attachment.snapshot.roomId, attachment.snapshot.roomInstanceId, participants, publications, attachment.snapshot.lobby, attachment.snapshot.spotlightPublicationId);
        const previousSocket = this.socket;
        this.socket = socket;
        this.snapshot_ = reconciledSnapshot;
        this.attachmentState = attachment.state;
        if (!this.recovery)
            this.state_ = attachment.state;
        this.#mediaCapability = attachment.mediaCapability;
        this.publicationIntents_.splice(0, this.publicationIntents_.length, ...publicationIntents);
        this.clearSnapshotResync();
        this.recoveryExhausted = false;
        if (previousSocket !== socket
            && (previousSocket.readyState === WebSocket.OPEN
                || previousSocket.readyState === WebSocket.CONNECTING)) {
            previousSocket.close();
        }
        return null;
    }
    /** @internal Reconcile retained publication intent before declaring control recovery complete. */
    async completeRecoveredTransport() {
        // The server deliberately retains a healthy SFU binding through control recovery.
        // Media reconciliation is owned by the single recovery coordinator below.
    }
    /** Retry after automatic recovery exhausted its configured budget. */
    retryRecovery() {
        if (!this.recoveryExhausted || this.closedByCaller) {
            return Promise.reject(new HellaveError("conflict", "Conference recovery is not awaiting an explicit retry."));
        }
        this.terminal = false;
        this.terminalError = null;
        this.recoveryExhausted = false;
        return this.startRecovery();
    }
    startRecovery(cause = "control") {
        if (cause === "media")
            this.mediaRecoveryRequested = true;
        if (this.recovery)
            return this.recovery;
        this.recoveryCause = cause;
        const controller = new AbortController();
        this.recoveryController = controller;
        const hasHealthyMedia = this.peerConnection !== null
            && this.peerConnection.connectionState !== "failed"
            && this.peerConnection.connectionState !== "closed";
        this.state_ = hasHealthyMedia ? "degraded" : "reconnecting";
        this.listener?.recovering(this.state_);
        const deadline = Date.now() + this.recoveryBudgetMs;
        const recovery = this.recoverWithinBudget(controller.signal, deadline)
            .finally(() => {
            if (this.recovery === recovery)
                this.recovery = null;
            if (this.recoveryController === controller)
                this.recoveryController = null;
        });
        this.recovery = recovery;
        return recovery;
    }
    async recoverWithinBudget(signal, deadline) {
        let attempt = 0;
        while (!signal.aborted && !this.closedByCaller) {
            try {
                if (this.recoveryCause === "control"
                    || this.controlRecoveryRequested
                    || this.socket.readyState !== WebSocket.OPEN) {
                    await this.recoverTransport(this, signal, deadline);
                    this.controlRecoveryRequested = false;
                }
                if (this.mediaRecoveryRequested || this.recoveryCause === "media") {
                    await this.recoverMedia(deadline, signal);
                    this.mediaRecoveryRequested = false;
                }
                if (this.controlRecoveryRequested || this.socket.readyState !== WebSocket.OPEN) {
                    this.recoveryCause = "control";
                    continue;
                }
                if (Date.now() >= deadline)
                    throw recoveryBudgetError();
                this.state_ = this.attachmentState;
                this.listener?.recovered(this.attachmentState, this.snapshot_);
                return;
            }
            catch (error) {
                if (signal.aborted || this.closedByCaller)
                    return;
                const failure = error instanceof HellaveError
                    ? error
                    : new HellaveError("temporarily_unavailable", "Public Edge recovery failed.");
                if (!failure.retryable) {
                    this.terminateFailed(failure);
                    throw failure;
                }
                if (Date.now() >= deadline) {
                    const exhausted = recoveryBudgetError();
                    this.recoveryExhausted = true;
                    this.suspendForExplicitRetry(exhausted);
                    throw exhausted;
                }
                const remaining = deadline - Date.now();
                const delay = Math.min(1_000, 100 * 2 ** Math.min(attempt, 3), remaining);
                attempt += 1;
                await abortableDelay(delay, signal);
                this.recoveryCause = this.socket.readyState === WebSocket.OPEN ? "media" : "control";
            }
        }
    }
    startMediaRecovery() {
        if (this.terminal || this.closedByCaller || this.leaving || this.attachmentState !== "admitted") {
            return Promise.resolve();
        }
        return this.startRecovery("media");
    }
    async recoverMedia(deadline, signal) {
        const active = this.activePublications.entries().next().value;
        if (!active) {
            await this.recoverTransport(this, signal, deadline);
            this.replacePeerConnection();
            return;
        }
        const [publicationId, binding] = active;
        const retainedPeer = this.peerConnection;
        if (retainedPeer && retainedPeer.connectionState !== "closed") {
            try {
                await this.renegotiateExistingPublication("media_restart", publicationId, binding, deadline, signal);
                return;
            }
            catch (error) {
                if (error instanceof HellaveError && !error.retryable)
                    throw error;
            }
        }
        await this.recoverTransport(this, signal, deadline);
        this.replacePeerConnection();
        await this.renegotiateExistingPublication("media_replace", publicationId, binding, deadline, signal);
    }
    async renegotiateExistingPublication(type, publicationId, binding, deadline, signal) {
        const socket = this.socket;
        // The third and last place we offer, so all three wait their turn.
        await this.settleOwnOffer();
        const operationGeneration = ++this.mediaOperationGeneration;
        const peer = this.peerConnection ?? this.ensurePeerConnection(this.lastIceServers);
        if (type === "media_replace") {
            const sender = peer.addTrack(binding.track, binding.stream);
            this.activePublications.set(publicationId, { ...binding, sender });
        }
        const offer = await withinDeadline(peer.createOffer(type === "media_restart" ? { iceRestart: true } : undefined), deadline, signal);
        if (peer !== this.peerConnection || operationGeneration !== this.mediaOperationGeneration) {
            throw new HellaveError("temporarily_unavailable", "Media recovery was replaced.");
        }
        await withinDeadline(peer.setLocalDescription(offer), deadline, signal);
        const transactionId = createCommandId();
        this.activeMediaTransaction = transactionId;
        this.holdOwnOffer(transactionId);
        this.mediaDescriptionSent = false;
        this.bufferedIceCandidates.length = 0;
        const answer = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingRecoveryAnswer?.transactionId === transactionId) {
                    this.pendingRecoveryAnswer = null;
                }
                reject(recoveryBudgetError());
            }, remainingTimeout(deadline, this.timeoutMs));
            this.pendingRecoveryAnswer = { transactionId, resolve, reject, timeout };
        });
        if (peer !== this.peerConnection
            || operationGeneration !== this.mediaOperationGeneration
            || socket !== this.socket) {
            throw new HellaveError("temporarily_unavailable", "Control attachment changed during media recovery.");
        }
        socket.send(JSON.stringify({ type, transaction_id: transactionId, publication_id: publicationId, sdp: offer.sdp }));
        this.mediaDescriptionSent = true;
        this.flushIceCandidates();
        await withinDeadline(answer, deadline, signal);
    }
    replacePeerConnection() {
        this.mediaOperationGeneration += 1;
        // Any offer we had outstanding belonged to the connection being discarded.
        this.releaseOwnOffer();
        this.stopQualityMonitoring();
        const peer = this.peerConnection;
        if (peer)
            peer.onconnectionstatechange = null;
        peer?.close();
        this.peerConnection = null;
    }
    suspendForExplicitRetry(error) {
        this.terminal = true;
        this.state_ = "failed";
        this.terminalError = error;
        const mediaNeedsRecovery = this.mediaRecoveryRequested
            || this.peerConnection?.connectionState === "failed"
            || this.peerConnection?.connectionState === "closed";
        if (mediaNeedsRecovery) {
            this.mediaRecoveryRequested = true;
            this.replacePeerConnection();
        }
        this.rejectPending(error);
        this.listener?.failed(error);
        this.closeSocketOnly();
    }
    failInvalidMessage() {
        this.terminateFailed(new HellaveError("invalid_request", "Public Edge returned an invalid message."));
    }
    terminateFailed(error, closeMedia = true) {
        if (this.terminal)
            return;
        this.terminal = true;
        this.state_ = "failed";
        this.terminalError = error;
        this.#mediaCapability = null;
        if (closeMedia)
            this.closeMedia();
        this.rejectPending(error);
        this.listener?.failed(error);
        this.closeSocketOnly();
    }
    rejectPending(error) {
        if (this.pendingRecording) {
            clearTimeout(this.pendingRecording.timeout);
            this.pendingRecording.reject(error);
            this.pendingRecording = null;
        }
        if (this.pendingRecoveryAnswer) {
            clearTimeout(this.pendingRecoveryAnswer.timeout);
            this.pendingRecoveryAnswer.reject(error);
            this.pendingRecoveryAnswer = null;
        }
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
        for (const pending of this.pendingPublications.values()) {
            clearTimeout(pending.timeout);
            if (pending.stopTrackOnFailure)
                pending.track.stop();
            pending.reject(error);
        }
        this.pendingPublications.clear();
    }
    rejectPendingAsUnknown() {
        for (const [commandId, pending] of this.pending) {
            clearTimeout(pending.timeout);
            this.unknownCommands.add(commandId);
            pending.reject(new HellaveError("temporarily_unavailable", "Room Command outcome is unknown because the Public Edge connection closed.", { commandId, outcome: "unknown" }));
        }
        this.pending.clear();
        for (const [commandId, pending] of this.pendingPublications) {
            clearTimeout(pending.timeout);
            this.unknownCommands.add(commandId);
            if (pending.stopTrackOnFailure)
                pending.track.stop();
            pending.reject(new HellaveError("temporarily_unavailable", "Publication outcome is unknown because the Public Edge connection closed.", { commandId, outcome: "unknown" }));
        }
        this.pendingPublications.clear();
    }
    async beginPublicationNegotiation(commandId, publicationId, iceServers, pending) {
        const socket = this.socket;
        // Before the generation is taken, so waiting cannot invalidate this operation. Publishing while
        // the transport offer was still unanswered put two of our offers in flight at once, and the
        // answer to the first was then read as a message for a transaction that is no longer current.
        await this.settleOwnOffer();
        const operationGeneration = ++this.mediaOperationGeneration;
        try {
            this.lastIceServers = iceServers;
            const peer = this.ensurePeerConnection(iceServers);
            if (!pending.reuseSender) {
                // addTransceiver, not addTrack: addTrack reuses a compatible recvonly transceiver and
                // merely flips its direction, so no new media section appears in the offer and the
                // Public Edge never sees the publication at all. One publication is one m-line, which
                // is also what the per-publication binding assumes.
                peer.addTransceiver(pending.track, {
                    direction: "sendonly",
                    streams: [pending.stream],
                    // The one place encodings reach the wire, and per source:
                    //
                    // - A camera publishes the three simulcast layers, so the SFU has something to choose
                    //   between. Without this it received one unlabelled encoding and could only pause a
                    //   stream under pressure, never shrink one.
                    // - A screen share publishes one bounded encoding. Halving the resolution of shared text
                    //   makes it unreadable, so it gets a ceiling instead of layers — and being single-layer is
                    //   exactly why the ceiling has to be set here.
                    // - A microphone gets neither.
                    ...encodingsForSource(pending.source),
                });
            }
            const offer = await peer.createOffer(pending.reuseSender ? { iceRestart: true } : undefined);
            if (peer !== this.peerConnection || operationGeneration !== this.mediaOperationGeneration) {
                throw new Error("media operation was replaced");
            }
            const transactionId = createCommandId();
            this.activeMediaTransaction = transactionId;
            this.holdOwnOffer(transactionId);
            this.activePublicationCommandId = commandId;
            this.mediaDescriptionSent = false;
            this.bufferedIceCandidates.length = 0;
            await peer.setLocalDescription(offer);
            if (peer !== this.peerConnection
                || operationGeneration !== this.mediaOperationGeneration
                || socket !== this.socket)
                throw new Error("media operation was replaced");
            socket.send(JSON.stringify({
                type: "media_offer",
                transaction_id: transactionId,
                command_id: commandId,
                publication_id: publicationId,
                source: pending.source,
                sdp: offer.sdp,
            }));
            this.mediaDescriptionSent = true;
            this.flushIceCandidates();
        }
        catch {
            this.failMediaTransaction(commandId);
        }
    }
    requestIceServers() {
        if (this.socket.readyState !== WebSocket.OPEN)
            return;
        this.socket.send(JSON.stringify({ type: "request_ice_servers" }));
    }
    /**
     * Ask for ICE servers and wait for them, so a transport is not built without any.
     *
     * The request is a socket message answered by ice_servers_updated, and nothing used to wait for
     * the answer: the first PeerConnection of a session was constructed with an empty list, so the
     * browser had no STUN to discover its public address with and no TURN to relay through. Every
     * candidate it produced was a host candidate, which on a page that has not been granted media
     * access is an mDNS hostname the node cannot use. Connections then survived only when a direct
     * UDP path happened to work, and a renegotiation could find no pairs at all.
     *
     * Bounded, and resolves either way: a credential service that is slow or down must degrade to
     * host-only rather than stop anyone joining.
     */
    async awaitIceServers() {
        if (this.lastIceServers.length > 0 && !this.refreshNeeded())
            return;
        if (this.socket.readyState !== WebSocket.OPEN)
            return;
        this.requestIceServers();
        await new Promise((resolve) => {
            const settle = () => {
                clearTimeout(timer);
                this.iceServersWaiters = this.iceServersWaiters.filter((each) => each !== settle);
                resolve();
            };
            const timer = setTimeout(() => {
                this.iceServersWaiters = this.iceServersWaiters.filter((each) => each !== settle);
                resolve();
            }, ICE_SERVERS_WAIT_MS);
            this.iceServersWaiters.push(settle);
        });
    }
    scheduleIceServersRefresh(ttlSecs) {
        this.clearIceServersRefresh();
        if (ttlSecs <= 0)
            return;
        const refreshMs = Math.max(ttlSecs * 800, 5_000);
        this.iceServersRefreshTimer = setTimeout(() => {
            this.requestIceServers();
        }, refreshMs);
    }
    clearIceServersRefresh() {
        if (this.iceServersRefreshTimer !== null) {
            clearTimeout(this.iceServersRefreshTimer);
            this.iceServersRefreshTimer = null;
        }
    }
    updateIceServers(iceServers, ttlSecs) {
        this.lastIceServers = iceServers;
        this.lastIceServersExpiresAt = Date.now() + ttlSecs * 1000;
        this.scheduleIceServersRefresh(ttlSecs);
        // Whoever is holding a transport open waiting for these.
        const waiting = this.iceServersWaiters;
        this.iceServersWaiters = [];
        for (const waiter of waiting)
            waiter();
        // A transport built before these arrived gathered host-only. It cannot re-gather without an
        // ICE restart, but adopting them now means the next renegotiation has them.
        this.adoptIceServers(iceServers);
    }
    adoptIceServers(iceServers) {
        const peer = this.peerConnection;
        if (!peer || typeof peer.setConfiguration !== "function")
            return;
        try {
            peer.setConfiguration({ iceServers: this.orderedIceServers(iceServers) });
        }
        catch {
            // Not fatal, and not worth a listener callback: the transport keeps whatever it has.
        }
    }
    enforceCodecBaseline(peer) {
        try {
            for (const transceiver of peer.getTransceivers()) {
                if (transceiver.receiver.track.kind === "audio") {
                    const capabilities = RTCRtpSender.getCapabilities("audio");
                    if (!capabilities)
                        continue;
                    const opus = capabilities.codecs.filter(c => c.mimeType === "audio/opus");
                    if (opus.length > 0) {
                        transceiver.setCodecPreferences(opus);
                    }
                }
                else if (transceiver.receiver.track.kind === "video") {
                    const capabilities = RTCRtpSender.getCapabilities("video");
                    if (!capabilities)
                        continue;
                    const baseline = capabilities.codecs.filter(c => c.mimeType === "video/VP8" || c.mimeType === "video/H264");
                    if (baseline.length > 0) {
                        transceiver.setCodecPreferences(baseline);
                    }
                }
            }
        }
        catch {
            // Codec preferences are best-effort: setCodecPreferences throws on browsers
            // that do not implement it, and the session must still connect without it.
        }
    }
    startQualityMonitoring() {
        this.stopQualityMonitoring();
        if (!this.peerConnection)
            return;
        const poll = () => {
            if (!this.peerConnection || this.terminal)
                return;
            void this.pollConnectionStats().catch(() => { });
            this.qualityTimer = setTimeout(poll, this.qualityPollIntervalMs);
        };
        this.qualityTimer = setTimeout(poll, this.qualityPollIntervalMs);
    }
    stopQualityMonitoring() {
        if (this.qualityTimer !== null) {
            clearTimeout(this.qualityTimer);
            this.qualityTimer = null;
        }
    }
    async pollConnectionStats() {
        const peer = this.peerConnection;
        if (!peer)
            return;
        const now = Date.now();
        try {
            const { rtt, jitter, packetLoss, candidateType } = await this.sampleTransport(peer);
            const quality = this.normalizeQuality(rtt, jitter, packetLoss, candidateType);
            const elapsed = now - this.lastQualityUpdate;
            if (quality !== this.connectionQuality_ && elapsed >= 2_000) {
                this.connectionQuality_ = quality;
                this.lastQualityUpdate = now;
                this.listener?.connectionQualityChanged(quality);
            }
        }
        catch {
            // Quality sampling is best-effort: a failed getStats must never surface as a
            // session error, and the next poll will try again.
        }
    }
    normalizeQuality(rtt, jitter, packetLoss, candidateType) {
        if (rtt > 1_000 || jitter > 0.5 || packetLoss > 0.3)
            return "failed";
        if (rtt > 500 || jitter > 0.2 || packetLoss > 0.15)
            return "poor";
        if (rtt > 200 || jitter > 0.1 || candidateType !== "host")
            return "fair";
        if (rtt > 100 || jitter > 0.05 || packetLoss > 0.02)
            return "good";
        return "excellent";
    }
    async requestDiagnostics() {
        const peer = this.peerConnection;
        if (!peer) {
            return {
                rtt: 0, jitter: 0, packetLoss: 0, bitrate: 0,
                candidateType: "unknown", protocol: "unknown",
                quality: this.connectionQuality_, timestamp: Date.now(),
            };
        }
        try {
            const { rtt, jitter, packetLoss, bitrate, candidateType, protocol } = await this.sampleTransport(peer);
            return {
                rtt: Math.round(rtt * 1000),
                jitter: Math.round(jitter * 1000),
                packetLoss: Math.round(packetLoss * 100),
                bitrate: Math.round(bitrate),
                candidateType,
                protocol,
                quality: this.normalizeQuality(rtt, jitter, packetLoss, candidateType),
                timestamp: Date.now(),
            };
        }
        catch {
            return {
                rtt: 0, jitter: 0, packetLoss: 0, bitrate: 0,
                candidateType: "unknown", protocol: "unknown",
                quality: this.connectionQuality_, timestamp: Date.now(),
            };
        }
    }
    /**
     * Walk getStats() once and summarise the transport.
     *
     * `candidate-pair` carries no candidate type of its own — the spec exposes it on the
     * `local-candidate` report that `localCandidateId` points at, so reading
     * `stat.localCandidateType` always fell through to the default and every session looked
     * like "host" even when relayed. `outbound-rtp` likewise has no `bitrate` member, so the
     * rate is derived from the change in `bytesSent`.
     */
    async sampleTransport(peer) {
        const stats = await peer.getStats();
        const reports = stats;
        const localCandidates = new Map();
        reports.forEach((stat, id) => {
            if (stat.type === "local-candidate")
                localCandidates.set(id, stat);
        });
        let rtt = 0;
        let jitter = 0;
        let packetLoss = 0;
        let bytesSent = 0;
        let candidateType = "unknown";
        let protocol = "unknown";
        reports.forEach((stat) => {
            if (stat.type === "candidate-pair" && stat.state === "succeeded") {
                rtt = stat.currentRoundTripTime ?? rtt;
                const local = localCandidates.get(stat.localCandidateId);
                if (local) {
                    candidateType = local.candidateType ?? candidateType;
                    protocol = local.protocol ?? protocol;
                }
            }
            if (stat.type === "inbound-rtp" && stat.kind === "audio") {
                jitter = stat.jitter ?? jitter;
                const lost = stat.packetsLost ?? 0;
                const total = stat.packetsReceived ?? 0;
                packetLoss = total > 0 ? lost / total : 0;
            }
            if (stat.type === "outbound-rtp" && stat.kind === "audio") {
                bytesSent += stat.bytesSent ?? 0;
            }
        });
        const now = Date.now();
        const elapsedSecs = this.lastBytesSentAt === 0 ? 0 : (now - this.lastBytesSentAt) / 1000;
        const bitrate = elapsedSecs > 0 && bytesSent >= this.lastBytesSent
            ? ((bytesSent - this.lastBytesSent) * 8) / elapsedSecs
            : 0;
        this.lastBytesSent = bytesSent;
        this.lastBytesSentAt = now;
        return { rtt, jitter, packetLoss, bitrate, candidateType, protocol };
    }
    orderedIceServers(iceServers) {
        const stunServers = [];
        const turnUdpServers = [];
        const turnTcpServers = [];
        for (const server of iceServers) {
            const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
            const isTurn = urls.some(url => url.startsWith("turn:") || url.startsWith("turns:"));
            if (!isTurn) {
                stunServers.push(server);
            }
            else if (urls.some(url => url.includes("?transport=tcp") || url.includes(":5349") || url.startsWith("turns:"))) {
                turnTcpServers.push(server);
            }
            else {
                turnUdpServers.push(server);
            }
        }
        return [...stunServers, ...turnUdpServers, ...turnTcpServers];
    }
    refreshNeeded() {
        return Date.now() >= this.lastIceServersExpiresAt - 30_000;
    }
    ensurePeerConnection(iceServers) {
        if (this.peerConnection)
            return this.peerConnection;
        if (this.refreshNeeded()) {
            this.requestIceServers();
        }
        const ordered = this.orderedIceServers(iceServers);
        const peer = new RTCPeerConnection({ iceServers: ordered });
        this.enforceCodecBaseline(peer);
        peer.onicecandidate = (event) => {
            if (peer !== this.peerConnection || !event.candidate || !this.activeMediaTransaction)
                return;
            const candidate = event.candidate.toJSON();
            if (!this.mediaDescriptionSent) {
                this.bufferedIceCandidates.push(candidate);
            }
            else {
                this.sendIceCandidate(candidate);
            }
        };
        peer.ontrack = (event) => {
            const mid = event.transceiver.mid;
            const binding = mid ? this.remotePublicationsByMid.get(mid) : undefined;
            // The binding is what maps a transport mid onto the domain identities; without it the
            // track cannot be attributed to a participant, so it is dropped.
            if (!binding)
                return;
            if (event.track.kind === "video") {
                this.listener?.remoteVideoTrack(new RemoteVideoTrack(binding.publicationId, binding.ownerParticipantId, event.track));
                return;
            }
            this.listener?.remoteMicrophoneTrack(new RemoteMicrophoneTrack(binding.publicationId, binding.ownerParticipantId, event.track));
        };
        peer.onconnectionstatechange = () => {
            if (peer !== this.peerConnection || peer.connectionState !== "failed")
                return;
            void this.startMediaRecovery().catch(() => { });
        };
        this.peerConnection = peer;
        this.startQualityMonitoring();
        return peer;
    }
    /**
     * Offer a receive-only transport for this attachment.
     *
     * Recvonly transceivers so the offer publishes nothing: the Public Edge enforces publish
     * permissions against the SDP, and a listener may hold a token that forbids publishing
     * entirely. Any later publication renegotiates this same connection.
     */
    async openMediaTransport() {
        if (this.terminal || this.closedByCaller || this.peerConnection)
            return;
        if (!this.serverCapabilities.includes(SUBSCRIBER_TRANSPORT_CAPABILITY))
            return;
        // Before the PeerConnection exists, not after. This is the session's first transport and the
        // one every later publication reuses, so a list that arrives late is a list never used: the
        // reservation carries real servers, but ensurePeerConnection hands back the existing
        // connection and they are discarded.
        await this.awaitIceServers();
        await this.settleOwnOffer();
        if (this.terminal || this.closedByCaller || this.peerConnection)
            return;
        const operationGeneration = ++this.mediaOperationGeneration;
        let peer = null;
        try {
            peer = this.ensurePeerConnection(this.lastIceServers);
            peer.addTransceiver("audio", { direction: "recvonly" });
            peer.addTransceiver("video", { direction: "recvonly" });
            const offer = await peer.createOffer();
            // Generation alone: any concurrent media operation bumps it, and this runs only when
            // there was no peer connection to be replaced.
            if (operationGeneration !== this.mediaOperationGeneration)
                return;
            await peer.setLocalDescription(offer);
            const transactionId = createCommandId();
            this.activeMediaTransaction = transactionId;
            // Missed when this guard was first added, which left a server offer crossing the *transport*
            // offer still able to take over the transaction slot.
            this.holdOwnOffer(transactionId);
            this.mediaDescriptionSent = false;
            this.bufferedIceCandidates.length = 0;
            this.socket.send(JSON.stringify({
                type: "media_transport_offer",
                transaction_id: transactionId,
                sdp: offer.sdp,
            }));
            this.mediaDescriptionSent = true;
            this.flushIceCandidates();
        }
        catch {
            // A transport that cannot be opened is not fatal: the attachment still carries chat,
            // hands and the room roster, and publishing later will try again.
            peer?.close();
            this.peerConnection = null;
        }
    }
    async answerServerOffer(transactionId, sdp) {
        const socket = this.socket;
        const operationGeneration = ++this.mediaOperationGeneration;
        try {
            const peer = this.peerConnection;
            if (!peer)
                throw new Error("media transport missing");
            this.activeMediaTransaction = transactionId;
            this.mediaDescriptionSent = false;
            this.bufferedIceCandidates.length = 0;
            await peer.setRemoteDescription({ type: "offer", sdp });
            if (peer !== this.peerConnection || operationGeneration !== this.mediaOperationGeneration) {
                throw new Error("media operation was replaced");
            }
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            if (peer !== this.peerConnection
                || operationGeneration !== this.mediaOperationGeneration
                || socket !== this.socket)
                throw new Error("media operation was replaced");
            socket.send(JSON.stringify({
                type: "media_answer",
                transaction_id: transactionId,
                sdp: answer.sdp,
            }));
            this.mediaDescriptionSent = true;
            this.flushIceCandidates();
        }
        catch {
            this.failMediaTransaction(this.activePublicationCommandId ?? undefined);
        }
    }
    async activatePublication(commandId, publicationId, revision) {
        const answer = this.pendingMediaAnswer;
        if (!answer || answer.transactionId !== this.activeMediaTransaction) {
            this.failMediaTransaction(commandId);
            return;
        }
        try {
            await answer.application;
        }
        catch {
            return;
        }
        if (this.pendingMediaAnswer === answer)
            this.pendingMediaAnswer = null;
        const pending = this.pendingPublications.get(commandId);
        if (!pending)
            return;
        const sender = this.peerConnection?.getSenders()
            .find((candidate) => candidate.track === pending.track);
        if (!sender) {
            this.failMediaTransaction(commandId);
            return;
        }
        this.pendingPublications.delete(commandId);
        clearTimeout(pending.timeout);
        this.unknownCommands.delete(commandId);
        this.activePublications.set(publicationId, {
            track: pending.track,
            stream: pending.stream,
            sender,
        });
        let publication = this.publications.get(publicationId);
        if (!publication) {
            publication = new MediaPublication(publicationId, this.localParticipantId, pending.source);
            this.publications.set(publicationId, publication);
            bindPublicationOwner(publication, this);
        }
        markPublicationActive(publication);
        const recoveredIntent = this.publicationIntents_
            .findIndex((publication) => publication.id === publicationId);
        if (recoveredIntent >= 0)
            this.publicationIntents_.splice(recoveredIntent, 1);
        if (revision !== this.snapshot_.revision)
            this.requestSnapshotResync();
        pending.resolve(publicationId);
    }
    /**
     * Server offers dropped because one of ours was outstanding.
     *
     * Rising is normal when several people publish at once. Rising without the media settling means the
     * two sides are trading offers instead of converging.
     */
    get crossedServerOfferCount() {
        return this.crossedServerOffers;
    }
    /**
     * Record that we are awaiting an answer for an offer we just sent.
     *
     * Every client-originated offer goes through here, so the set of callers is the set of places that
     * send one: openMediaTransport, beginPublicationNegotiation and renegotiateExistingPublication.
     * answerServerOffer deliberately does not — that offer is the Edge's, not ours.
     */
    holdOwnOffer(transactionId) {
        this.ownOfferTransaction = transactionId;
    }
    /**
     * Release the outstanding offer and wake anything waiting on it.
     *
     * Centralised because the field has to be released down every exit — answered, failed, peer
     * connection replaced, media closed — and a missed one silently drops every server offer from then
     * on. Shipping it with two of the four covered is exactly the mistake this replaces.
     */
    releaseOwnOffer() {
        this.ownOfferTransaction = null;
        for (const wake of this.ownOfferWaiters.splice(0))
            wake();
    }
    /**
     * Wait until no offer of ours is outstanding.
     *
     * The client cannot have two offers in flight: it keeps one transaction, so the second overwrites
     * the first and the answer to the first is then read as a message for a transaction that is not
     * current — which terminates the attachment. Publishing while the transport offer was still
     * unanswered did exactly that, invisibly on loopback and roughly two runs in three against a real
     * network.
     *
     * Bounded, and gives up by proceeding rather than throwing: proceeding is what happened before this
     * existed, so a stuck transaction degrades to the old behaviour instead of hanging the publish.
     */
    async settleOwnOffer() {
        if (this.ownOfferTransaction === null)
            return;
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                const index = this.ownOfferWaiters.indexOf(wake);
                if (index >= 0)
                    this.ownOfferWaiters.splice(index, 1);
                resolve();
            }, this.timeoutMs);
            const wake = () => {
                clearTimeout(timeout);
                resolve();
            };
            this.ownOfferWaiters.push(wake);
        });
    }
    failMediaTransaction(commandId) {
        const error = new HellaveError("temporarily_unavailable", "Media negotiation failed.");
        this.pendingMediaAnswer = null;
        // Released here as well as on the answer. A transaction that fails is no longer outstanding, and
        // leaving it set would silently drop every server offer from here on — the participant would stop
        // hearing anyone who publishes, which is worse than the failure being reported.
        this.releaseOwnOffer();
        if (commandId) {
            const pending = this.pendingPublications.get(commandId);
            if (pending) {
                this.pendingPublications.delete(commandId);
                clearTimeout(pending.timeout);
                if (pending.stopTrackOnFailure)
                    pending.track.stop();
                pending.reject(error);
            }
            this.sendPublicationRollback(commandId);
        }
    }
    requestSnapshotResync() {
        if (this.snapshotResyncPending || this.terminal || this.closedByCaller)
            return;
        this.snapshotResyncPending = true;
        this.socket.send(JSON.stringify({
            type: "snapshot_request",
            known_revision: this.snapshot_.revision,
        }));
        this.snapshotResyncTimeout = setTimeout(() => {
            this.terminateFailed(new HellaveError("temporarily_unavailable", "Authoritative room snapshot resynchronization timed out."));
        }, this.timeoutMs);
    }
    clearSnapshotResync() {
        this.snapshotResyncPending = false;
        if (this.snapshotResyncTimeout)
            clearTimeout(this.snapshotResyncTimeout);
        this.snapshotResyncTimeout = null;
        this.unknownCommands.clear();
    }
    flushIceCandidates() {
        for (const candidate of this.bufferedIceCandidates.splice(0)) {
            this.sendIceCandidate(candidate);
        }
    }
    sendIceCandidate(candidate) {
        if (!this.activeMediaTransaction)
            return;
        this.socket.send(JSON.stringify({
            type: "media_ice",
            transaction_id: this.activeMediaTransaction,
            candidate,
        }));
    }
    sendPublicationRollback(commandId) {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: "publication_rollback",
                command_id: commandId,
            }));
        }
    }
    closeMedia() {
        this.stopQualityMonitoring();
        for (const binding of this.activePublications.values())
            binding.track.stop();
        this.activePublications.clear();
        this.peerConnection?.close();
        this.peerConnection = null;
        this.activeMediaTransaction = null;
        // The fourth release, and the second one missed first time round.
        this.releaseOwnOffer();
        this.activePublicationCommandId = null;
        this.pendingMediaAnswer = null;
        this.mediaDescriptionSent = false;
        this.bufferedIceCandidates.length = 0;
        this.remotePublicationsByMid.clear();
        this.clearSnapshotResync();
    }
    closeSocketOnly() {
        if (this.socket.readyState === WebSocket.OPEN
            || this.socket.readyState === WebSocket.CONNECTING) {
            this.socket.close();
        }
    }
}
/** @internal */
export class ControlClient {
    controlSocketUrl;
    tokenProvider;
    timeoutMs;
    recoveryBudgetMs;
    constructor(controlSocketUrl, tokenProvider, timeoutMs, recoveryBudgetMs) {
        this.controlSocketUrl = controlSocketUrl;
        this.tokenProvider = tokenProvider;
        this.timeoutMs = timeoutMs;
        this.recoveryBudgetMs = recoveryBudgetMs;
    }
    attach(roomId, roomInstanceId, callerSignal) {
        return new Promise((resolve, reject) => {
            const providerController = new AbortController();
            const socket = new WebSocket(this.controlSocketUrl);
            let settled = false;
            let negotiated = null;
            let providerPromise = null;
            let session = null;
            let phase = "awaiting_welcome";
            const cleanup = () => {
                clearTimeout(timeout);
                callerSignal?.removeEventListener("abort", onAbort);
            };
            const closeInitial = () => {
                providerController.abort();
                if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                    socket.close();
                }
            };
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                closeInitial();
                reject(error);
            };
            const onAbort = () => {
                fail(new HellaveError("request_cancelled", "Conference attachment was cancelled."));
            };
            const timeout = setTimeout(() => {
                fail(new HellaveError("temporarily_unavailable", "Conference attachment timed out."));
            }, this.timeoutMs);
            callerSignal?.addEventListener("abort", onAbort, { once: true });
            if (callerSignal?.aborted) {
                onAbort();
                return;
            }
            socket.onopen = () => {
                socket.send(JSON.stringify({
                    type: "hello",
                    sdk: { name: SDK_NAME, version: SDK_VERSION, platform: "browser" },
                    contract_release: CONTRACT_RELEASE.version,
                    protocol: {
                        major: CONTRACT_RELEASE.protocol.major,
                        min_minor: CONTRACT_RELEASE.protocol.minMinor,
                        max_minor: CONTRACT_RELEASE.protocol.maxMinor,
                    },
                    capabilities: [
                        WAITING_CAPABILITY,
                        LOBBY_CAPABILITY,
                        MICROPHONE_CAPABILITY,
                        AUTHORITATIVE_STATE_CAPABILITY,
                        ATTACHMENT_LIFECYCLE_CAPABILITY,
                        ROOM_INSTANCE_LIFECYCLE_CAPABILITY,
                        BOUNDED_RECOVERY_CAPABILITY,
                        PUBLISH_BLOCK_POLICY_CAPABILITY,
                        // Optional: the Public Edge only sends chat and participant-signal messages to
                        // clients that ask for them, so advertising here is what turns them on.
                        ROOM_MESSAGING_CAPABILITY,
                        PARTICIPANT_SIGNALS_CAPABILITY,
                        RECORDING_CONTROL_CAPABILITY,
                        SUBSCRIBER_TRANSPORT_CAPABILITY,
                    ],
                }));
            };
            socket.onerror = () => {
                if (session)
                    session.handleTransportFailure(socket);
                else
                    fail(new HellaveError("temporarily_unavailable", "Public Edge connection failed."));
            };
            socket.onclose = () => {
                if (session)
                    session.handleTransportFailure(socket);
                else if (!settled) {
                    fail(new HellaveError("temporarily_unavailable", "Public Edge connection closed."));
                }
            };
            socket.onmessage = (event) => {
                const message = parseControlMessage(event.data);
                if (!message) {
                    if (session) {
                        session.handleMessage({ type: "invalid" }, socket);
                    }
                    else {
                        fail(new HellaveError("invalid_request", "Public Edge returned an invalid message."));
                    }
                    return;
                }
                if (session) {
                    session.handleMessage(message, socket);
                    return;
                }
                if (message.type === "control_error") {
                    const error = hasExactKeys(message, ["type", "error"])
                        ? parseErrorEnvelope(message.error)
                        : null;
                    fail(error ?? new HellaveError("invalid_request", "Public Edge returned an invalid error."));
                    return;
                }
                if (message.type === "welcome") {
                    if (phase !== "awaiting_welcome" || negotiated || !isWelcome(message)) {
                        fail(new HellaveError("incompatible_protocol", "Public Edge is not SDK-compatible."));
                        return;
                    }
                    phase = "acquiring_token";
                    negotiated = {
                        contractRelease: message.contract_release,
                        protocol: Object.freeze({ ...message.protocol }),
                        capabilities: Object.freeze([...message.capabilities]),
                    };
                    providerPromise ??= Promise.resolve().then(() => this.tokenProvider({
                        roomId,
                        roomInstanceId,
                        reason: "attach",
                        signal: providerController.signal,
                    }));
                    providerPromise
                        .then((credential) => {
                        if (settled || providerController.signal.aborted || phase !== "acquiring_token")
                            return;
                        if (!isRecord(credential)
                            || typeof credential.token !== "string"
                            || credential.token.trim().length === 0
                            || credential.token.length > 8_192) {
                            throw new HellaveError("authentication_failed", "Token provider returned an invalid credential.");
                        }
                        phase = "awaiting_attached";
                        socket.send(JSON.stringify({ type: "attach", token: credential.token }));
                    })
                        .catch((error) => {
                        fail(error instanceof HellaveError
                            ? error
                            : new HellaveError("authentication_failed", "Token provider failed."));
                    });
                    return;
                }
                if (message.type === "attached") {
                    if (phase !== "awaiting_attached" || !negotiated) {
                        fail(new HellaveError("invalid_request", "Public Edge returned an invalid attachment."));
                        return;
                    }
                    const attachment = parseAttached(message, roomId, roomInstanceId);
                    if (attachment instanceof HellaveError) {
                        fail(attachment);
                        return;
                    }
                    phase = "attached";
                    settled = true;
                    cleanup();
                    session = new ControlSession(socket, attachment.snapshot, attachment.participant, attachment.state, attachment.mediaCapability, attachment.publicationIntents, attachment.participant.capabilities.moderateLobby, negotiated.capabilities, this.timeoutMs, this.recoveryBudgetMs, (recoveringSession, signal, deadline) => this.recover(recoveringSession, signal, deadline));
                    resolve({
                        participant: attachment.participant,
                        snapshot: attachment.snapshot,
                        conferenceState: attachment.state,
                        negotiated,
                        session,
                    });
                    return;
                }
                fail(new HellaveError("invalid_request", "Public Edge returned an unexpected message."));
            };
        });
    }
    recover(session, signal, deadline) {
        const { roomId, roomInstanceId } = session.roomIdentity;
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(this.controlSocketUrl);
            let phase = "awaiting_welcome";
            let settled = false;
            const cleanup = () => {
                clearTimeout(timeout);
                signal.removeEventListener("abort", onAbort);
            };
            const close = () => {
                if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                    socket.close();
                }
            };
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                close();
                reject(error);
            };
            const onAbort = () => {
                fail(new HellaveError("request_cancelled", "Conference recovery was cancelled."));
            };
            const timeout = setTimeout(() => {
                fail(new HellaveError("temporarily_unavailable", "Control recovery attempt timed out."));
            }, remainingTimeout(deadline, this.timeoutMs));
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
                onAbort();
                return;
            }
            socket.onopen = () => {
                socket.send(JSON.stringify(controlHello()));
            };
            socket.onerror = () => {
                fail(new HellaveError("temporarily_unavailable", "Public Edge recovery failed."));
            };
            socket.onclose = () => {
                fail(new HellaveError("temporarily_unavailable", "Public Edge recovery closed."));
            };
            socket.onmessage = (event) => {
                const message = parseControlMessage(event.data);
                if (!message) {
                    fail(new HellaveError("invalid_request", "Public Edge returned an invalid message."));
                    return;
                }
                if (message.type === "control_error") {
                    const error = hasExactKeys(message, ["type", "error"])
                        ? parseErrorEnvelope(message.error)
                        : null;
                    fail(error ?? new HellaveError("invalid_request", "Public Edge returned an invalid error."));
                    return;
                }
                if (message.type === "welcome") {
                    if (phase !== "awaiting_welcome" || !isWelcome(message)) {
                        fail(new HellaveError("incompatible_protocol", "Public Edge is not SDK-compatible."));
                        return;
                    }
                    phase = "acquiring_token";
                    Promise.resolve().then(() => this.tokenProvider({
                        roomId,
                        roomInstanceId,
                        reason: "reconnect",
                        signal,
                    })).then((credential) => {
                        if (settled || signal.aborted || phase !== "acquiring_token")
                            return;
                        if (!isRecord(credential)
                            || typeof credential.token !== "string"
                            || credential.token.trim().length === 0
                            || credential.token.length > 8_192) {
                            throw new HellaveError("authentication_failed", "Token provider returned an invalid credential.");
                        }
                        phase = "awaiting_attached";
                        socket.send(JSON.stringify({ type: "attach", token: credential.token }));
                    }).catch((error) => {
                        fail(error instanceof HellaveError
                            ? error
                            : new HellaveError("authentication_failed", "Token provider failed."));
                    });
                    return;
                }
                if (message.type !== "attached" || phase !== "awaiting_attached") {
                    fail(new HellaveError("invalid_request", "Public Edge returned an invalid attachment."));
                    return;
                }
                const attachment = parseAttached(message, roomId, roomInstanceId);
                const installError = session.installRecoveredTransport(socket, attachment);
                if (installError) {
                    fail(installError);
                    return;
                }
                cleanup();
                socket.onerror = () => session.handleTransportFailure(socket);
                socket.onclose = () => session.handleTransportFailure(socket);
                socket.onmessage = (nextEvent) => {
                    const next = parseControlMessage(nextEvent.data);
                    session.handleMessage(next ?? { type: "invalid" }, socket);
                };
                void session.completeRecoveredTransport().then(() => {
                    settled = true;
                    resolve();
                }).catch((error) => {
                    fail(error instanceof HellaveError
                        ? error
                        : new HellaveError("temporarily_unavailable", "Media reconciliation failed."));
                });
            };
        });
    }
}
function parseAttached(value, roomId, roomInstanceId, participantRegistry = new Map(), publicationRegistry = new Map()) {
    const state = value.conference_state;
    const expectedKeys = state === "admitted"
        ? ["type", "conference_state", "participant", "snapshot", "media_capability", "publication_intents"]
        : ["type", "conference_state", "participant", "snapshot", "publication_intents"];
    if ((state !== "waiting" && state !== "admitted")
        || !hasExactKeys(value, expectedKeys)
        || !isRecord(value.participant)
        || !isRecord(value.snapshot)
        || !Array.isArray(value.publication_intents)
        || (state === "admitted" && !isMediaCapability(value.media_capability))) {
        return new HellaveError("invalid_request", "Public Edge returned an invalid attachment.");
    }
    let participant;
    try {
        const parsed = participantFromWire(value.participant);
        const existing = participantRegistry.get(parsed.id);
        if (existing) {
            reconcileRoomParticipant(existing, parsed.profile, parsed.role, parsed.capabilities, parsed.muted, parsed.publishBlocked);
            participant = existing;
        }
        else {
            participant = parsed;
            participantRegistry.set(parsed.id, parsed);
        }
    }
    catch {
        return new HellaveError("invalid_request", "Public Edge returned invalid state.");
    }
    const snapshot = parseSnapshot(value.snapshot, roomId, roomInstanceId, participant.capabilities.moderateLobby, participantRegistry, publicationRegistry);
    if (snapshot instanceof HellaveError)
        return snapshot;
    if (state === "waiting"
        && (snapshot.participants.length !== 0 || snapshot.publications.length !== 0)) {
        return new HellaveError("invalid_request", "Waiting attachments cannot receive admitted room state.");
    }
    const mediaCapability = state === "admitted" && isMediaCapability(value.media_capability)
        ? { token: value.media_capability.token, expiresAt: value.media_capability.expires_at }
        : null;
    const publicationIntents = [];
    for (const item of value.publication_intents) {
        if (!isRecord(item)
            || !hasExactKeys(item, ["id", "owner_participant_id", "source"])
            || !isBoundedId(item.id)
            || item.owner_participant_id !== participant.id
            || !isPublicationSource(item.source)) {
            return new HellaveError("invalid_request", "Public Edge returned invalid publication intent.");
        }
        const publication = publicationRegistry.get(item.id)
            ?? new MediaPublication(item.id, participant.id, item.source);
        publicationRegistry.set(item.id, publication);
        if (!snapshot.publications.some((active) => active.id === publication.id)) {
            markPublicationStopped(publication);
        }
        publicationIntents.push(publication);
    }
    return { participant, snapshot, state, mediaCapability, publicationIntents };
}
function isWelcome(value) {
    return hasExactKeys(value, ["type", "contract_release", "protocol", "capabilities"])
        && value.contract_release === CONTRACT_RELEASE.version
        && isProtocolVersion(value.protocol)
        && isProtocolCompatible(value.protocol)
        && Array.isArray(value.capabilities)
        && value.capabilities.length <= 32
        && value.capabilities.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 64)
        && new Set(value.capabilities).size === value.capabilities.length
        && value.capabilities.includes(WAITING_CAPABILITY)
        && value.capabilities.includes(LOBBY_CAPABILITY)
        && value.capabilities.includes(MICROPHONE_CAPABILITY)
        && value.capabilities.includes(AUTHORITATIVE_STATE_CAPABILITY)
        && value.capabilities.includes(ATTACHMENT_LIFECYCLE_CAPABILITY)
        && value.capabilities.includes(ROOM_INSTANCE_LIFECYCLE_CAPABILITY)
        && value.capabilities.includes(BOUNDED_RECOVERY_CAPABILITY);
}
function controlHello() {
    return {
        type: "hello",
        sdk: { name: SDK_NAME, version: SDK_VERSION, platform: "browser" },
        contract_release: CONTRACT_RELEASE.version,
        protocol: {
            major: CONTRACT_RELEASE.protocol.major,
            min_minor: CONTRACT_RELEASE.protocol.minMinor,
            max_minor: CONTRACT_RELEASE.protocol.maxMinor,
        },
        capabilities: [
            WAITING_CAPABILITY,
            LOBBY_CAPABILITY,
            MICROPHONE_CAPABILITY,
            AUTHORITATIVE_STATE_CAPABILITY,
            ATTACHMENT_LIFECYCLE_CAPABILITY,
            ROOM_INSTANCE_LIFECYCLE_CAPABILITY,
            BOUNDED_RECOVERY_CAPABILITY,
            PUBLISH_BLOCK_POLICY_CAPABILITY,
            ROOM_MESSAGING_CAPABILITY,
            PARTICIPANT_SIGNALS_CAPABILITY,
            RECORDING_CONTROL_CAPABILITY,
        ],
    };
}
function abortableDelay(delayMs, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timeout);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function participantFromWire(value) {
    const hasLegacyKeys = hasExactKeys(value, ["id", "profile", "role", "capabilities", "muted"]);
    const hasPolicyKeys = hasExactKeys(value, ["id", "profile", "role", "capabilities", "muted", "publish_blocked"]);
    if ((!hasLegacyKeys && !hasPolicyKeys)
        || !isBoundedId(value.id)
        || typeof value.role !== "string"
        || !["host", "participant", "viewer"].includes(value.role)
        || !isProfile(value.profile)
        || !isCapabilities(value.capabilities)
        || !isMuteState(value.muted)
        || (hasPolicyKeys && !isMuteState(value.publish_blocked))) {
        throw new HellaveError("invalid_request", "Public Edge returned an invalid participant.");
    }
    return new RoomParticipant(value.id, profileFromWire(value.profile), value.role, {
        publishAudio: value.capabilities.publish_audio,
        publishVideo: value.capabilities.publish_video,
        shareScreen: value.capabilities.share_screen,
        sendMessages: value.capabilities.send_messages,
        moderateLobby: value.capabilities.moderate_lobby,
        moderateParticipants: value.capabilities.moderate_participants,
        setSpotlight: value.capabilities.set_spotlight,
        controlRecording: value.capabilities.control_recording,
        updateProfile: value.capabilities.update_profile,
    }, { audio: value.muted.audio, video: value.muted.video }, hasPolicyKeys && isMuteState(value.publish_blocked)
        ? { audio: value.publish_blocked.audio, video: value.publish_blocked.video }
        : { audio: value.muted.audio, video: value.muted.video });
}
function parseDelta(value, current, allowLobby, participantRegistry, publicationRegistry) {
    if (!hasExactKeys(value, [
        "base_revision",
        "revision",
        "participants_upserted",
        "participant_ids_removed",
        "publications_upserted",
        "publication_ids_removed",
        "lobby",
        "spotlight_publication_id",
    ])
        || value.base_revision !== current.revision
        || value.revision !== current.revision + 1
        || !Array.isArray(value.participants_upserted)
        || value.participants_upserted.length > 500
        || !Array.isArray(value.participant_ids_removed)
        || value.participant_ids_removed.length > 500
        || !Array.isArray(value.publications_upserted)
        || value.publications_upserted.length > 500
        || !Array.isArray(value.publication_ids_removed)
        || value.publication_ids_removed.length > 500
        || !Array.isArray(value.lobby)
        || value.lobby.length > 500
        || (!allowLobby && value.lobby.length !== 0)) {
        return new HellaveError("invalid_request", "Public Edge returned an invalid room delta.");
    }
    const participantRemovals = new Set();
    for (const id of value.participant_ids_removed) {
        if (!isBoundedId(id) || participantRemovals.has(id)) {
            return new HellaveError("invalid_request", "Room delta has invalid participant removals.");
        }
        participantRemovals.add(id);
    }
    const participantChanges = new Map();
    for (const item of value.participants_upserted) {
        if (!isRecord(item)) {
            return new HellaveError("invalid_request", "Room delta has invalid participants.");
        }
        let participant;
        try {
            participant = participantFromWire(item);
        }
        catch {
            return new HellaveError("invalid_request", "Room delta has invalid participants.");
        }
        if (participantChanges.has(participant.id) || participantRemovals.has(participant.id)) {
            return new HellaveError("invalid_request", "Room delta repeats a participant identity.");
        }
        participantChanges.set(participant.id, participant);
    }
    const nextParticipants = new Map(current.participants.map((item) => [item.id, item]));
    for (const id of participantRemovals)
        nextParticipants.delete(id);
    for (const [id, participant] of participantChanges)
        nextParticipants.set(id, participant);
    const publicationRemovals = new Set();
    for (const id of value.publication_ids_removed) {
        if (!isBoundedId(id) || publicationRemovals.has(id)) {
            return new HellaveError("invalid_request", "Room delta has invalid publication removals.");
        }
        publicationRemovals.add(id);
    }
    const publicationChanges = new Map();
    for (const item of value.publications_upserted) {
        if (!isRecord(item)
            || !hasExactKeys(item, ["id", "owner_participant_id", "source"])
            || !isBoundedId(item.id)
            || !isBoundedId(item.owner_participant_id)
            || !isPublicationSource(item.source)
            || !nextParticipants.has(item.owner_participant_id)
            || publicationChanges.has(item.id)
            || publicationRemovals.has(item.id)) {
            return new HellaveError("invalid_request", "Room delta has invalid publications.");
        }
        const existing = publicationRegistry.get(item.id);
        if (existing && (existing.ownerParticipantId !== item.owner_participant_id
            || existing.source !== item.source)) {
            return new HellaveError("invalid_request", "Publication identity changed authority.");
        }
        publicationChanges.set(item.id, {
            id: item.id,
            ownerParticipantId: item.owner_participant_id,
            source: item.source,
        });
    }
    const nextPublicationIds = new Set(current.publications.map((item) => item.id));
    for (const id of publicationRemovals)
        nextPublicationIds.delete(id);
    for (const id of publicationChanges.keys())
        nextPublicationIds.add(id);
    for (const publicationId of nextPublicationIds) {
        const change = publicationChanges.get(publicationId);
        const publication = change ?? publicationRegistry.get(publicationId);
        if (!publication || !nextParticipants.has(publication.ownerParticipantId)) {
            return new HellaveError("invalid_request", "Room delta leaves an orphaned publication.");
        }
    }
    const lobby = [];
    for (const item of value.lobby) {
        if (!isRecord(item)
            || !hasExactKeys(item, ["id", "profile"])
            || !isBoundedId(item.id)
            || !isProfile(item.profile)) {
            return new HellaveError("invalid_request", "Room delta has an invalid lobby.");
        }
        lobby.push(new LobbyParticipant(item.id, profileFromWire(item.profile)));
    }
    for (const [id, parsed] of participantChanges) {
        const existing = participantRegistry.get(id);
        if (existing) {
            reconcileRoomParticipant(existing, parsed.profile, parsed.role, parsed.capabilities, parsed.muted, parsed.publishBlocked);
            nextParticipants.set(id, existing);
        }
        else {
            participantRegistry.set(id, parsed);
        }
    }
    for (const id of publicationRemovals) {
        const publication = publicationRegistry.get(id);
        if (publication)
            markPublicationStopped(publication);
    }
    for (const change of publicationChanges.values()) {
        if (!publicationRegistry.has(change.id)) {
            publicationRegistry.set(change.id, new MediaPublication(change.id, change.ownerParticipantId, change.source));
        }
        markPublicationActive(publicationRegistry.get(change.id));
    }
    pruneHistoricalRegistry(participantRegistry, new Set(nextParticipants.keys()));
    pruneHistoricalRegistry(publicationRegistry, nextPublicationIds);
    const spotlightPublicationId = typeof value.spotlight_publication_id === "string" && value.spotlight_publication_id.length > 0
        ? value.spotlight_publication_id
        : null;
    return new RoomSnapshot(value.revision, current.roomId, current.roomInstanceId, [...nextParticipants.values()], [...nextPublicationIds].map((id) => publicationRegistry.get(id)), lobby, spotlightPublicationId);
}
function parseSnapshot(value, roomId, roomInstanceId, allowLobby, participantRegistry = new Map(), publicationRegistry = new Map()) {
    if (!hasExactKeys(value, [
        "revision",
        "room_id",
        "room_instance_id",
        "participants",
        "publications",
        "lobby",
        "spotlight_publication_id",
    ])
        || !isRevision(value.revision)
        || value.room_id !== roomId
        || typeof value.room_id !== "string"
        || value.room_id.length > 256
        || value.room_instance_id !== roomInstanceId
        || !isUuid(roomInstanceId)
        || !Array.isArray(value.participants)
        || value.participants.length > 500
        || !Array.isArray(value.publications)
        || value.publications.length > 500
        || !Array.isArray(value.lobby)
        || value.lobby.length > 500
        || (!allowLobby && value.lobby.length !== 0)) {
        return new HellaveError("invalid_request", "Public Edge returned an invalid room snapshot.");
    }
    const lobby = [];
    const parsedParticipants = [];
    const seenParticipants = new Set();
    for (const item of value.participants) {
        if (!isRecord(item)) {
            return new HellaveError("invalid_request", "Public Edge returned invalid participants.");
        }
        let parsed;
        try {
            parsed = participantFromWire(item);
        }
        catch {
            return new HellaveError("invalid_request", "Public Edge returned invalid participants.");
        }
        if (seenParticipants.has(parsed.id)) {
            return new HellaveError("invalid_request", "Public Edge returned duplicate participants.");
        }
        seenParticipants.add(parsed.id);
        parsedParticipants.push(parsed);
    }
    const parsedPublications = [];
    const seenPublications = new Set();
    for (const item of value.publications) {
        if (!isRecord(item)
            || !hasExactKeys(item, ["id", "owner_participant_id", "source"])
            || !isBoundedId(item.id)
            || !isBoundedId(item.owner_participant_id)
            || !isPublicationSource(item.source)
            || !seenParticipants.has(item.owner_participant_id)
            || seenPublications.has(item.id)) {
            return new HellaveError("invalid_request", "Public Edge returned invalid publications.");
        }
        const existing = publicationRegistry.get(item.id);
        if (existing && (existing.ownerParticipantId !== item.owner_participant_id
            || existing.source !== item.source)) {
            return new HellaveError("invalid_request", "Publication identity changed authority.");
        }
        seenPublications.add(item.id);
        parsedPublications.push({
            id: item.id,
            ownerParticipantId: item.owner_participant_id,
            source: item.source,
        });
    }
    for (const item of value.lobby) {
        if (!isRecord(item)
            || !hasExactKeys(item, ["id", "profile"])
            || !isBoundedId(item.id)
            || !isProfile(item.profile)) {
            return new HellaveError("invalid_request", "Public Edge returned an invalid lobby.");
        }
        lobby.push(new LobbyParticipant(item.id, profileFromWire(item.profile)));
    }
    const participants = [];
    for (const parsed of parsedParticipants) {
        const existing = participantRegistry.get(parsed.id);
        if (existing) {
            reconcileRoomParticipant(existing, parsed.profile, parsed.role, parsed.capabilities, parsed.muted, parsed.publishBlocked);
            participants.push(existing);
        }
        else {
            participantRegistry.set(parsed.id, parsed);
            participants.push(parsed);
        }
    }
    const publications = [];
    for (const item of parsedPublications) {
        let publication = publicationRegistry.get(item.id);
        if (!publication) {
            publication = new MediaPublication(item.id, item.ownerParticipantId, item.source);
            publicationRegistry.set(item.id, publication);
        }
        markPublicationActive(publication);
        publications.push(publication);
    }
    for (const [publicationId, publication] of publicationRegistry) {
        if (!seenPublications.has(publicationId)) {
            markPublicationStopped(publication);
        }
    }
    pruneHistoricalRegistry(participantRegistry, seenParticipants);
    pruneHistoricalRegistry(publicationRegistry, seenPublications);
    const spotlightPublicationId = typeof value.spotlight_publication_id === "string" && value.spotlight_publication_id.length > 0
        ? value.spotlight_publication_id
        : null;
    return new RoomSnapshot(value.revision, roomId, roomInstanceId, participants, publications, lobby, spotlightPublicationId);
}
function pruneHistoricalRegistry(registry, liveIds) {
    const maximumRetainedIdentities = 1_000;
    if (registry.size <= maximumRetainedIdentities)
        return;
    for (const id of registry.keys()) {
        if (!liveIds.has(id))
            registry.delete(id);
        if (registry.size <= maximumRetainedIdentities)
            return;
    }
}
function snapshotsEquivalent(left, right) {
    const project = (snapshot) => ({
        revision: snapshot.revision,
        roomId: snapshot.roomId,
        roomInstanceId: snapshot.roomInstanceId,
        participants: snapshot.participants.map((participant) => ({
            id: participant.id,
            profile: participant.profile,
            role: participant.role,
            capabilities: participant.capabilities,
            muted: participant.muted,
            publishBlocked: participant.publishBlocked,
        })).sort((a, b) => a.id.localeCompare(b.id)),
        publications: snapshot.publications.map((publication) => ({
            id: publication.id,
            ownerParticipantId: publication.ownerParticipantId,
            source: publication.source,
        })).sort((a, b) => a.id.localeCompare(b.id)),
        lobby: snapshot.lobby.map((participant) => ({
            id: participant.id,
            profile: participant.profile,
        })).sort((a, b) => a.id.localeCompare(b.id)),
    });
    return JSON.stringify(project(left)) === JSON.stringify(project(right));
}
function parseErrorEnvelope(value) {
    if (!isRecord(value)
        || !hasExactKeys(value, ["code", "message", "retryable", "context"])
        || !isHellaveErrorEnvelope(value)
        || value.message.length < 1
        || value.message.length > 512) {
        return null;
    }
    return new HellaveError(value.code, value.message, value.context);
}
function isMediaCapability(value) {
    return isRecord(value)
        && hasExactKeys(value, ["token", "expires_at"])
        && typeof value.token === "string"
        && value.token.length >= 1
        && value.token.length <= 8_192
        && isRevision(value.expires_at);
}
function isIceServers(value) {
    return Array.isArray(value) && value.length <= 16 && value.every((server) => isRecord(server)
        && hasExactKeys(server, [
            "urls",
            ...(server.username === undefined ? [] : ["username"]),
            ...(server.credential === undefined ? [] : ["credential"]),
        ])
        && Array.isArray(server.urls)
        && server.urls.length >= 1
        && server.urls.length <= 16
        && server.urls.every((url) => typeof url === "string" && url.length >= 1 && url.length <= 2_048)
        && (server.username === undefined
            || (typeof server.username === "string" && server.username.length <= 512))
        && (server.credential === undefined
            || (typeof server.credential === "string" && server.credential.length <= 512)));
}
function isIceCandidate(value) {
    return isRecord(value)
        && Object.keys(value).every((key) => ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"].includes(key))
        && typeof value.candidate === "string"
        && value.candidate.length <= 4_096
        && (value.sdpMid === undefined || value.sdpMid === null || typeof value.sdpMid === "string")
        && (value.sdpMid === undefined
            || value.sdpMid === null
            || value.sdpMid.length <= 128)
        && (value.sdpMLineIndex === undefined
            || value.sdpMLineIndex === null
            || (Number.isInteger(value.sdpMLineIndex)
                && value.sdpMLineIndex >= 0
                && value.sdpMLineIndex <= 65_535))
        && (value.usernameFragment === undefined
            || value.usernameFragment === null
            || (typeof value.usernameFragment === "string"
                && value.usernameFragment.length <= 256));
}
function isProtocolVersion(value) {
    return isRecord(value)
        && hasExactKeys(value, ["major", "minor"])
        && Number.isInteger(value.major)
        && Number.isInteger(value.minor)
        && value.major >= 1
        && value.minor >= 0;
}
/**
 * Validate a room-facing profile.
 *
 * `avatar_url` may be absent or explicitly `null`: ParticipantProfile declares it
 * `#[serde(default)] Option<String>` with no `skip_serializing_if`, so the backend always
 * emits the key and sends `null` when there is no avatar. Treating `null` as invalid
 * rejected every real participant with "Public Edge returned invalid state."
 */
function isProfile(value) {
    if (!isRecord(value))
        return false;
    const avatarUrl = value.avatar_url;
    return hasExactKeys(value, "avatar_url" in value ? ["display_name", "avatar_url"] : ["display_name"])
        && typeof value.display_name === "string"
        && value.display_name.length >= 1
        && value.display_name.length <= 120
        && (avatarUrl === undefined
            || avatarUrl === null
            || (typeof avatarUrl === "string"
                && avatarUrl.length <= 2_048
                && isUri(avatarUrl)));
}
function profileFromWire(value) {
    return {
        displayName: value.display_name,
        ...(value.avatar_url === undefined || value.avatar_url === null
            ? {}
            : { avatarUrl: value.avatar_url }),
    };
}
function isCapabilities(value) {
    if (!isRecord(value))
        return false;
    const names = [
        "publish_audio",
        "publish_video",
        "share_screen",
        "send_messages",
        "moderate_lobby",
        "moderate_participants",
        "set_spotlight",
        "control_recording",
        "update_profile",
    ];
    return hasExactKeys(value, names)
        && names.every((name) => typeof value[name] === "boolean");
}
function isMuteState(value) {
    return isRecord(value)
        && hasExactKeys(value, ["audio", "video"])
        && typeof value.audio === "boolean"
        && typeof value.video === "boolean";
}
function parseControlMessage(data) {
    if (typeof data !== "string")
        return null;
    try {
        const value = JSON.parse(data);
        return isRecord(value) && typeof value.type === "string" ? value : null;
    }
    catch {
        return null;
    }
}
function createCommandId() {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function")
        return randomUuid.call(globalThis.crypto);
    fallbackCommandSequence += 1;
    return `js-${Date.now().toString(36)}-${fallbackCommandSequence.toString(36)}`;
}
function recoveryBudgetError() {
    return new HellaveError("temporarily_unavailable", "Conference Recovery Budget was exhausted; retry explicitly.", { reason: "recovery_budget_exhausted" });
}
function snapshotFingerprint(snapshot) {
    return JSON.stringify({
        revision: snapshot.revision,
        roomId: snapshot.roomId,
        roomInstanceId: snapshot.roomInstanceId,
        participants: snapshot.participants.map((participant) => ({
            id: participant.id,
            profile: participant.profile,
            role: participant.role,
            capabilities: participant.capabilities,
            muted: participant.muted,
        })),
        publications: snapshot.publications.map((publication) => ({
            id: publication.id,
            ownerParticipantId: publication.ownerParticipantId,
            source: publication.source,
            state: publication.state,
        })),
        lobby: snapshot.lobby.map((participant) => ({ id: participant.id, profile: participant.profile })),
    });
}
function remainingTimeout(deadline, maximum) {
    return Math.max(1, Math.min(maximum, deadline - Date.now()));
}
function withinDeadline(operation, deadline, signal) {
    if (signal.aborted) {
        return Promise.reject(new HellaveError("request_cancelled", "Recovery was cancelled."));
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0)
        return Promise.reject(recoveryBudgetError());
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(recoveryBudgetError());
        }, remaining);
        const onAbort = () => {
            cleanup();
            reject(new HellaveError("request_cancelled", "Recovery was cancelled."));
        };
        const cleanup = () => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
}
function isRevision(value) {
    return Number.isSafeInteger(value) && value >= 1;
}
function isNonNegativeFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
/**
 * Whether a wire value names a publication source this release understands.
 *
 * The parsers below all rejected anything but "microphone", so the first camera or screen
 * publication in a room tore down every client with "invalid_request" — including clients
 * that had published nothing themselves.
 */
function isPublicationSource(value) {
    return value === "microphone" || value === "camera" || value === "screen"
        || value === "screen_audio";
}
function isBoundedId(value) {
    return typeof value === "string" && value.length >= 1 && value.length <= 128;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(value);
}
function isUri(value) {
    try {
        return new URL(value).protocol.length > 1;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=ControlClient.js.map