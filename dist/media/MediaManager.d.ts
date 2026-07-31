import { LocalTrack } from "./LocalTrack.js";
export interface MediaConfig {
    audio?: boolean | MediaTrackConstraints;
    video?: boolean | MediaTrackConstraints;
}
export declare function createLocalTracks(config?: MediaConfig): Promise<LocalTrack[]>;
export declare function createScreenTrack(options?: DisplayMediaStreamOptions): Promise<LocalTrack>;
export declare function getAudioInputDevices(): Promise<MediaDeviceInfo[]>;
export declare function getVideoInputDevices(): Promise<MediaDeviceInfo[]>;
export declare function getAudioOutputDevices(): Promise<MediaDeviceInfo[]>;
//# sourceMappingURL=MediaManager.d.ts.map