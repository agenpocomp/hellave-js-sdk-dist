import { EventEmitter } from "../events/EventEmitter.js";
export class LocalTrack extends EventEmitter {
    kind;
    stream;
    transceiverDirection;
    mediaStreamTrack_;
    muted_ = false;
    screenShare_ = false;
    _rids;
    constructor(track, stream, options) {
        super();
        this.kind = track.kind;
        this.mediaStreamTrack_ = track;
        this.stream = stream;
        this.transceiverDirection = options?.transceiverDirection ?? "sendonly";
        this.screenShare_ = options?.screenShare ?? false;
        this._rids = options?.rids ?? [];
        track.addEventListener("ended", () => {
            this.emit("ended");
        });
    }
    get id() {
        return this.mediaStreamTrack_.id;
    }
    get label() {
        return this.mediaStreamTrack_.label;
    }
    get mediaStreamTrack() {
        return this.mediaStreamTrack_;
    }
    get muted() {
        return this.muted_;
    }
    get screenShare() {
        return this.screenShare_;
    }
    get rids() {
        return this._rids;
    }
    mute() {
        if (this.muted_)
            return;
        this.muted_ = true;
        this.mediaStreamTrack_.enabled = false;
        this.emit("muteChanged", true);
    }
    unmute() {
        if (!this.muted_)
            return;
        this.muted_ = false;
        this.mediaStreamTrack_.enabled = true;
        this.emit("muteChanged", false);
    }
    stop() {
        this.mediaStreamTrack_.stop();
        this.removeAllListeners();
    }
    replaceTrack(newTrack) {
        const wasMuted = this.muted_;
        this.mediaStreamTrack_ = newTrack;
        this.muted_ = wasMuted;
        if (!wasMuted) {
            newTrack.enabled = true;
        }
        else {
            newTrack.enabled = false;
        }
        newTrack.addEventListener("ended", () => {
            this.emit("ended");
        });
    }
}
//# sourceMappingURL=LocalTrack.js.map