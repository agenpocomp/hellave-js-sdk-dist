import type { RoomCommandOptions } from "../RoomCommand.js";
import { CaptureTrack, type CaptureSource } from "./CaptureTrack.js";
import type { MediaPublication } from "./MediaPublication.js";
export interface ActivePublications {
    readonly microphone?: MediaPublication;
    readonly camera?: MediaPublication;
    readonly screen?: MediaPublication;
    readonly screenAudio?: MediaPublication;
}
export interface DeviceControllerControl {
    publishCapture(source: CaptureSource, track: MediaStreamTrack, stream: MediaStream, callerCommandId?: string): Promise<string>;
    replacePublicationTrack(publicationId: string, track: MediaStreamTrack): Promise<boolean>;
    getActiveSources(): ActivePublications;
    ownsPublication(publicationId: string): boolean;
    getLocalParticipantId(): string;
}
export declare class MediaDeviceController {
    private readonly control;
    constructor(control: DeviceControllerControl);
    enumerateAudioInputs(): Promise<MediaDeviceInfo[]>;
    enumerateVideoInputs(): Promise<MediaDeviceInfo[]>;
    enumerateAudioOutputs(): Promise<MediaDeviceInfo[]>;
    enumerateAll(): Promise<{
        audioinputs: MediaDeviceInfo[];
        videoinputs: MediaDeviceInfo[];
        audiooutputs: MediaDeviceInfo[];
    }>;
    capturePreview(constraints: MediaStreamConstraints): Promise<CaptureTrack[]>;
    captureScreen(options?: DisplayMediaStreamOptions): Promise<CaptureTrack>;
    publishCapture(capture: CaptureTrack, options?: RoomCommandOptions): Promise<MediaPublication>;
    switchDevice(publication: MediaPublication, constraints?: {
        deviceId?: string;
        audio?: boolean | MediaTrackConstraints;
        video?: boolean | MediaTrackConstraints;
    }): Promise<MediaPublication>;
    setSinkId(element: HTMLMediaElement, sinkId: string): Promise<void>;
    get activePublications(): ActivePublications;
}
//# sourceMappingURL=MediaDeviceController.d.ts.map