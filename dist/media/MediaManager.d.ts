import { LocalTrack } from "./LocalTrack.js";
export interface MediaConfig {
    audio?: boolean | MediaTrackConstraints;
    video?: boolean | MediaTrackConstraints;
}
/**
 * The layers a camera publishes, in ascending order.
 *
 * Exported because `ControlClient` is what applies them: they reach the wire only by being passed as
 * `sendEncodings` when the transceiver is created. They lived here unused for a long time — declared,
 * carried on `LocalTrack.rids`, and read by nothing — which is why the SFU only ever observed a single
 * unlabelled layer and its bandwidth ceilings, priority caps and layer suspension had nothing to
 * choose between: under pressure it could pause a stream but never shrink one.
 *
 * Resolution is halved and quartered rather than only bitrate-capped, because an encoder given a lower
 * bitrate at full resolution spends it on blur; the receiver wanting `low` wants a small picture.
 */
export declare const SIMULCAST_ENCODINGS: ({
    rid: string;
    maxBitrate: number;
    scaleResolutionDownBy: number;
} | {
    rid: string;
    maxBitrate: number;
    scaleResolutionDownBy?: never;
})[];
export declare function createLocalTracks(config?: MediaConfig): Promise<LocalTrack[]>;
export declare function createScreenTrack(options?: DisplayMediaStreamOptions): Promise<LocalTrack>;
export declare function getAudioInputDevices(): Promise<MediaDeviceInfo[]>;
export declare function getVideoInputDevices(): Promise<MediaDeviceInfo[]>;
export declare function getAudioOutputDevices(): Promise<MediaDeviceInfo[]>;
//# sourceMappingURL=MediaManager.d.ts.map