import { EventEmitter } from "../events/EventEmitter.js";
const ACTIVE_SPEAKER_THRESHOLD_DB = -55;
const ACTIVE_SPEAKER_FIRE_MS = 300;
const DOMINANCE_WINDOW_MS = 2_000;
export class ActiveSpeakerDetector extends EventEmitter {
    audioContext = null;
    analysers = new Map();
    sourceMap = new Map();
    animationFrameId = null;
    currentSpeaker = null;
    dominanceStart = null;
    running = false;
    addRemoteTrack(track) {
        if (track.kind !== "audio")
            return;
        if (!this.audioContext) {
            this.audioContext = new AudioContext();
        }
        const source = this.audioContext.createMediaStreamSource(track.stream);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);
        this.sourceMap.set(track.peerId, source);
        this.analysers.set(track.peerId, analyser);
    }
    removeRemoteTrack(track) {
        if (track.kind !== "audio")
            return;
        const source = this.sourceMap.get(track.peerId);
        if (source) {
            source.disconnect();
            this.sourceMap.delete(track.peerId);
        }
        this.analysers.delete(track.peerId);
        if (this.currentSpeaker === track.peerId) {
            this.currentSpeaker = null;
            this.dominanceStart = null;
        }
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        if (this.audioContext?.state === "suspended") {
            await this.audioContext.resume();
        }
        this.poll();
    }
    stop() {
        this.running = false;
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }
    destroy() {
        this.stop();
        for (const source of this.sourceMap.values()) {
            source.disconnect();
        }
        this.sourceMap.clear();
        this.analysers.clear();
        this.removeAllListeners();
        if (this.audioContext) {
            this.audioContext.close().catch(() => { });
            this.audioContext = null;
        }
    }
    poll() {
        if (!this.running)
            return;
        const now = performance.now();
        const levels = [];
        for (const [peerId, analyser] of this.analysers) {
            const data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteTimeDomainData(data);
            let sumSquares = 0;
            for (let i = 0; i < data.length; i++) {
                const deviation = data[i] - 128;
                sumSquares += deviation * deviation;
            }
            const rms = Math.sqrt(sumSquares / data.length);
            const db = rms === 0 ? -100 : 20 * Math.log10(rms / 128);
            levels.push({ peerId, level: db, timestamp: now });
            this.emit("audioLevel", peerId, db);
        }
        const activeAboveThreshold = levels.filter((e) => e.level > ACTIVE_SPEAKER_THRESHOLD_DB);
        const loudest = activeAboveThreshold.sort((a, b) => b.level - a.level)[0] ?? null;
        if (loudest) {
            if (this.currentSpeaker === loudest.peerId) {
                if (this.dominanceStart !== null && now - this.dominanceStart >= DOMINANCE_WINDOW_MS) {
                    this.emit("activeSpeaker", loudest.peerId);
                }
            }
            else {
                if (this.currentSpeaker !== null && this.dominanceStart !== null) {
                    const elapsed = now - this.dominanceStart;
                    if (elapsed >= ACTIVE_SPEAKER_FIRE_MS) {
                        this.emit("activeSpeaker", loudest.peerId);
                        this.currentSpeaker = loudest.peerId;
                        this.dominanceStart = now;
                    }
                }
                else {
                    this.currentSpeaker = loudest.peerId;
                    this.dominanceStart = now;
                }
            }
        }
        else {
            if (this.currentSpeaker !== null) {
                this.currentSpeaker = null;
                this.dominanceStart = null;
            }
        }
        this.animationFrameId = requestAnimationFrame(() => this.poll());
    }
}
//# sourceMappingURL=ActiveSpeakerDetector.js.map