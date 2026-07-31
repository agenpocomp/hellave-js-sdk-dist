import { EventEmitter } from "../events/EventEmitter.js";
import type { RemoteTrack } from "./RemoteTrack.js";
interface ActiveSpeakerEvents {
    activeSpeaker: [peerId: string | null];
    audioLevel: [peerId: string, level: number];
}
export declare class ActiveSpeakerDetector extends EventEmitter<ActiveSpeakerEvents> {
    private audioContext;
    private analysers;
    private sourceMap;
    private animationFrameId;
    private currentSpeaker;
    private dominanceStart;
    private running;
    addRemoteTrack(track: RemoteTrack): void;
    removeRemoteTrack(track: RemoteTrack): void;
    start(): Promise<void>;
    stop(): void;
    destroy(): void;
    private poll;
}
export {};
//# sourceMappingURL=ActiveSpeakerDetector.d.ts.map