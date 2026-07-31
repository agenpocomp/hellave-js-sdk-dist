import { EventEmitter } from "../events/EventEmitter.js";
export class RemoteTrack extends EventEmitter {
    kind;
    peerId;
    trackId;
    mediaStreamTrack_;
    muted_ = false;
    stream_;
    constructor(track, peerId, stream, initiallyMuted) {
        super();
        this.kind = track.kind;
        this.peerId = peerId;
        this.trackId = track.id;
        this.mediaStreamTrack_ = track;
        this.muted_ = initiallyMuted;
        this.stream_ = stream;
        track.addEventListener("mute", () => {
            this.muted_ = true;
            this.emit("muteChanged", true);
        });
        track.addEventListener("unmute", () => {
            this.muted_ = false;
            this.emit("muteChanged", false);
        });
        track.addEventListener("ended", () => {
            this.emit("ended");
        });
    }
    get id() {
        return this.mediaStreamTrack_.id;
    }
    get mediaStreamTrack() {
        return this.mediaStreamTrack_;
    }
    get stream() {
        return this.stream_;
    }
    get muted() {
        return this.muted_;
    }
}
//# sourceMappingURL=RemoteTrack.js.map