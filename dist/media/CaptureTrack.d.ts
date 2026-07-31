import { EventEmitter } from "../events/EventEmitter.js";
export type CaptureSource = "microphone" | "camera" | "screen" | "screen_audio";
export type CaptureTrackOwnership = "sdk" | "application";
export interface CaptureTrackEvents {
    ended: [];
    muteChanged: [muted: boolean];
}
export declare class CaptureTrack extends EventEmitter<CaptureTrackEvents> {
    readonly source: CaptureSource;
    constructor(source: CaptureSource, track: MediaStreamTrack, ownership?: CaptureTrackOwnership);
    get mediaStreamTrack(): MediaStreamTrack;
    get muted(): boolean;
    get ownership(): CaptureTrackOwnership;
    get ended(): boolean;
    mute(): void;
    unmute(): void;
    stop(): void;
    replaceTrack(track: MediaStreamTrack): void;
}
//# sourceMappingURL=CaptureTrack.d.ts.map