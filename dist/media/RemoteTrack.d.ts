import { EventEmitter } from "../events/EventEmitter.js";
export type TrackKind = "audio" | "video";
export interface RemoteTrackEvents {
    muteChanged: [muted: boolean];
    ended: [];
    audioLevel: [level: number];
}
export declare class RemoteTrack extends EventEmitter<RemoteTrackEvents> {
    readonly kind: TrackKind;
    readonly peerId: string;
    readonly trackId: string;
    private mediaStreamTrack_;
    private muted_;
    private stream_;
    constructor(track: MediaStreamTrack, peerId: string, stream: MediaStream, initiallyMuted: boolean);
    get id(): string;
    get mediaStreamTrack(): MediaStreamTrack;
    get stream(): MediaStream;
    get muted(): boolean;
}
//# sourceMappingURL=RemoteTrack.d.ts.map