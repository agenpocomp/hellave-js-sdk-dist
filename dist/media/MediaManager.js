import { LocalTrack } from "./LocalTrack.js";
const DEFAULT_VIDEO_CONSTRAINTS = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
};
const SIMULCAST_ENCODINGS = [
    { rid: "l", maxBitrate: 150_000, scaleResolutionDownBy: 4 },
    { rid: "m", maxBitrate: 700_000, scaleResolutionDownBy: 2 },
    { rid: "h", maxBitrate: 1_500_000 },
];
export async function createLocalTracks(config) {
    const tracks = [];
    if (!config || config.audio !== false || config.video !== false) {
        const audio = config?.audio ?? true;
        const video = config?.video ?? true;
        const constraints = {};
        if (audio) {
            constraints.audio = audio === true ? true : audio;
        }
        if (video) {
            constraints.video = video === true ? DEFAULT_VIDEO_CONSTRAINTS : video;
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        for (const track of stream.getAudioTracks()) {
            tracks.push(new LocalTrack(track, stream, { transceiverDirection: "sendonly" }));
        }
        for (const track of stream.getVideoTracks()) {
            tracks.push(new LocalTrack(track, stream, {
                transceiverDirection: "sendonly",
                rids: SIMULCAST_ENCODINGS,
            }));
        }
    }
    return tracks;
}
export async function createScreenTrack(options) {
    const stream = await navigator.mediaDevices.getDisplayMedia(options ?? { video: true });
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
        throw new Error("screen capture did not produce a video track");
    }
    return new LocalTrack(videoTrack, stream, {
        transceiverDirection: "sendonly",
        screenShare: true,
    });
}
export async function getAudioInputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
}
export async function getVideoInputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
}
export async function getAudioOutputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audiooutput");
}
//# sourceMappingURL=MediaManager.js.map