import { HellaveError } from "../contracts.js";
import { CaptureTrack } from "./CaptureTrack.js";
export class MediaDeviceController {
    control;
    constructor(control) {
        this.control = control;
    }
    async enumerateAudioInputs() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === "audioinput");
    }
    async enumerateVideoInputs() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === "videoinput");
    }
    async enumerateAudioOutputs() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === "audiooutput");
    }
    async enumerateAll() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return {
            audioinputs: devices.filter((d) => d.kind === "audioinput"),
            videoinputs: devices.filter((d) => d.kind === "videoinput"),
            audiooutputs: devices.filter((d) => d.kind === "audiooutput"),
        };
    }
    async capturePreview(constraints) {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const tracks = [];
        for (const track of stream.getAudioTracks()) {
            tracks.push(new CaptureTrack("microphone", track, "sdk"));
        }
        for (const track of stream.getVideoTracks()) {
            tracks.push(new CaptureTrack("camera", track, "sdk"));
        }
        if (tracks.length === 0) {
            for (const track of stream.getTracks())
                track.stop();
            throw new HellaveError("invalid_request", "Capture produced no tracks.");
        }
        return tracks;
    }
    async captureScreen(options) {
        const stream = await navigator.mediaDevices.getDisplayMedia(options ?? { video: true, audio: true });
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) {
            for (const track of stream.getTracks())
                track.stop();
            throw new HellaveError("invalid_request", "Screen capture produced no video track.");
        }
        return new CaptureTrack("screen", videoTrack, "application");
    }
    async publishCapture(capture, options) {
        const existing = this.control.getActiveSources();
        if (existing.microphone && capture.source === "microphone") {
            throw new HellaveError("conflict", "A microphone publication already exists; switch devices or stop it first.", { source: "microphone", existingPublicationId: existing.microphone.id });
        }
        if (existing.camera && capture.source === "camera") {
            throw new HellaveError("conflict", "A camera publication already exists; switch devices or stop it first.", { source: "camera", existingPublicationId: existing.camera.id });
        }
        if (existing.screen && capture.source === "screen") {
            throw new HellaveError("conflict", "A screen publication already exists; switch devices or stop it first.", { source: "screen", existingPublicationId: existing.screen.id });
        }
        const stream = new MediaStream([capture.mediaStreamTrack]);
        const publicationId = await this.control.publishCapture(capture.source, capture.mediaStreamTrack, stream, options?.commandId);
        const updated = this.control.getActiveSources();
        const publication = updated.microphone?.id === publicationId
            ? updated.microphone
            : updated.camera?.id === publicationId
                ? updated.camera
                : updated.screen?.id === publicationId
                    ? updated.screen
                    : updated.screenAudio?.id === publicationId
                        ? updated.screenAudio
                        : undefined;
        if (!publication) {
            throw new HellaveError("internal", "Publication identity is unavailable after reservation.");
        }
        return publication;
    }
    async switchDevice(publication, constraints) {
        if (!this.control.ownsPublication(publication.id)) {
            throw new HellaveError("authorization_denied", "Cannot switch device on a publication owned by another participant.");
        }
        const isAudio = publication.source === "microphone";
        const mediaConstraints = constraints
            ? {
                audio: isAudio
                    ? (constraints.audio ?? (constraints.deviceId ? { deviceId: constraints.deviceId } : true))
                    : false,
                video: !isAudio
                    ? (constraints.video ?? (constraints.deviceId ? { deviceId: constraints.deviceId } : true))
                    : false,
            }
            : (isAudio ? { audio: true } : { video: true });
        const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
        const newTrack = isAudio ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
        if (!newTrack) {
            for (const track of stream.getTracks())
                track.stop();
            throw new HellaveError("invalid_request", `Device switch produced no ${isAudio ? "audio" : "video"} track.`);
        }
        try {
            const replaced = await this.control.replacePublicationTrack(publication.id, newTrack);
            if (!replaced) {
                newTrack.stop();
                throw new HellaveError("temporarily_unavailable", "Device switch failed to replace the media track.");
            }
            return publication;
        }
        catch (error) {
            newTrack.stop();
            throw error;
        }
    }
    async setSinkId(element, sinkId) {
        if (typeof element.setSinkId !== "function") {
            throw new HellaveError("invalid_request", "Audio output selection is not supported in this browser.");
        }
        try {
            await element.setSinkId(sinkId);
        }
        catch {
            throw new HellaveError("invalid_request", `Audio output device "${sinkId}" is not available.`, { sinkId });
        }
    }
    get activePublications() {
        return this.control.getActiveSources();
    }
}
//# sourceMappingURL=MediaDeviceController.js.map