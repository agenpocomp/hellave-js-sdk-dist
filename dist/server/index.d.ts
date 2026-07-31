export declare class HellaveApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly retryable: boolean;
    readonly context: Record<string, unknown> | undefined;
    constructor(response: {
        status: number;
        code?: string;
        message?: string;
        retryable?: boolean;
        context?: Record<string, unknown>;
    });
}
interface CreateRoomInstanceParams {
    roomId: string;
    expiresAt: number;
    policy: {
        lobbyEnabled: boolean;
        maxParticipants: number;
        maxActiveVideoPublications: number;
        reconnectGraceSeconds: number;
    };
}
interface RoomInstanceResponse {
    roomInstanceId: string;
    organizationId: string;
    roomId: string;
    policy: {
        lobbyEnabled: boolean;
        maxParticipants: number;
        maxActiveVideoPublications: number;
        reconnectGraceSeconds: number;
    };
    expiresAt: number;
    state: "active" | "expired" | "destroyed";
    createdAt: number;
}
interface IssueMeetingTokenParams {
    peerId: string;
    sessionId: string;
    profile: {
        displayName: string;
        avatarUrl?: string | null;
    };
    role: "host" | "participant" | "viewer";
    capabilities: {
        publishAudio: boolean;
        publishVideo: boolean;
        shareScreen: boolean;
        sendMessages: boolean;
        moderateLobby: boolean;
        moderateParticipants: boolean;
        setSpotlight: boolean;
        controlRecording: boolean;
        updateProfile: boolean;
    };
    lobby?: boolean;
}
interface MeetingTokenResponse {
    token: string;
    tokenType: string;
    expiresIn: number;
    expiresAt: number;
}
interface CreateMeetingParams {
    roomId?: string;
    peerId: string;
    displayName: string;
    avatarUrl?: string | null;
    role?: "host" | "participant" | "viewer";
    lobby?: boolean;
    expiresInSeconds?: number;
}
interface CreateMeetingResult {
    roomInstanceId: string;
    token: string;
    expiresAt: number;
}
export declare class HellaveApiClient {
    #private;
    constructor(opts: {
        baseUrl: string;
        apiKey: string;
    });
    createRoomInstance(params: CreateRoomInstanceParams, idempotencyKey: string): Promise<RoomInstanceResponse>;
    destroyRoomInstance(roomInstanceId: string): Promise<void>;
    issueMeetingToken(roomInstanceId: string, params: IssueMeetingTokenParams): Promise<MeetingTokenResponse>;
    createMeeting(params: CreateMeetingParams): Promise<CreateMeetingResult>;
    getJwks(): Promise<{
        keys: Array<Record<string, unknown>>;
    }>;
    healthCheck(): Promise<{
        ok: boolean;
    }>;
}
export {};
//# sourceMappingURL=index.d.ts.map