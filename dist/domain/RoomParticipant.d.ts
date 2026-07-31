export interface ParticipantProfile {
    readonly displayName: string;
    readonly avatarUrl?: string;
}
export interface ParticipantCapabilities {
    readonly publishAudio: boolean;
    readonly publishVideo: boolean;
    readonly shareScreen: boolean;
    readonly sendMessages: boolean;
    readonly moderateLobby: boolean;
    readonly moderateParticipants: boolean;
    readonly setSpotlight: boolean;
    readonly controlRecording: boolean;
    readonly updateProfile: boolean;
}
export interface ParticipantMuteState {
    readonly audio: boolean;
    readonly video: boolean;
}
/** Server-authorized participant identity exposed by the stable SDK. */
export declare class RoomParticipant {
    readonly id: string;
    constructor(id: string, profile: ParticipantProfile, role: string, capabilities: ParticipantCapabilities, muted: ParticipantMuteState, publishBlocked?: ParticipantMuteState);
    get profile(): ParticipantProfile;
    get role(): string;
    get capabilities(): ParticipantCapabilities;
    get muted(): ParticipantMuteState;
    /** Server-enforced publish policy; independent from participant-private Local Mute. */
    get publishBlocked(): ParticipantMuteState;
}
//# sourceMappingURL=RoomParticipant.d.ts.map