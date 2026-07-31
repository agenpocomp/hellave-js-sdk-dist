import { EventEmitter } from "../events/EventEmitter.js";
const mutableState = new WeakMap();
export class CaptureTrack extends EventEmitter {
    source;
    constructor(source, track, ownership = "sdk") {
        super();
        this.source = source;
        const state = {
            mediaStreamTrack: track,
            muted: false,
            ownership,
            ended: false,
        };
        mutableState.set(this, state);
        track.addEventListener("ended", () => {
            state.ended = true;
            this.emit("ended");
        });
    }
    get mediaStreamTrack() {
        return captureState(this).mediaStreamTrack;
    }
    get muted() {
        return captureState(this).muted;
    }
    get ownership() {
        return captureState(this).ownership;
    }
    get ended() {
        return captureState(this).ended;
    }
    mute() {
        const state = captureState(this);
        if (state.muted)
            return;
        state.muted = true;
        state.mediaStreamTrack.enabled = false;
        this.emit("muteChanged", true);
    }
    unmute() {
        const state = captureState(this);
        if (!state.muted)
            return;
        state.muted = false;
        state.mediaStreamTrack.enabled = true;
        this.emit("muteChanged", false);
    }
    stop() {
        const state = captureState(this);
        if (state.ended)
            return;
        state.ended = true;
        state.mediaStreamTrack.stop();
        this.removeAllListeners();
    }
    replaceTrack(track) {
        const state = captureState(this);
        state.mediaStreamTrack.stop();
        state.mediaStreamTrack = track;
        state.ended = false;
        track.addEventListener("ended", () => {
            state.ended = true;
            this.emit("ended");
        });
    }
}
function captureState(capture) {
    const state = mutableState.get(capture);
    if (!state)
        throw new Error("CaptureTrack was not initialized.");
    return state;
}
//# sourceMappingURL=CaptureTrack.js.map