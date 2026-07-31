import { EventEmitter } from "../events/EventEmitter.js";
export type TrackKind = "audio" | "video";
export interface LocalTrackEvents {
    muteChanged: [muted: boolean];
    ended: [];
}
export declare class LocalTrack extends EventEmitter<LocalTrackEvents> {
    readonly kind: TrackKind;
    readonly stream: MediaStream;
    readonly transceiverDirection: RTCRtpTransceiverDirection;
    private mediaStreamTrack_;
    private muted_;
    private screenShare_;
    private _rids;
    constructor(track: MediaStreamTrack, stream: MediaStream, options?: {
        transceiverDirection?: RTCRtpTransceiverDirection;
        screenShare?: boolean;
        rids?: {
            rid: string;
            maxBitrate: number;
            scaleResolutionDownBy?: number;
        }[];
    });
    get id(): string;
    get label(): string;
    get mediaStreamTrack(): MediaStreamTrack;
    get muted(): boolean;
    get screenShare(): boolean;
    get rids(): {
        rid: string;
        maxBitrate: number;
        scaleResolutionDownBy?: number;
    }[];
    mute(): void;
    unmute(): void;
    stop(): void;
    replaceTrack(newTrack: MediaStreamTrack): void;
}
//# sourceMappingURL=LocalTrack.d.ts.map