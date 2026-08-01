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
    /** Place this participant in the lobby, awaiting admission by a moderator. */
    lobby?: boolean;
    expiresInSeconds?: number;
    /**
     * Room policy overrides. `lobbyEnabled` was previously forced to false, which made the
     * backend's lobby_admission capability unreachable for anyone using createMeeting.
     */
    policy?: {
        lobbyEnabled?: boolean;
        maxParticipants?: number;
        maxActiveVideoPublications?: number;
        reconnectGraceSeconds?: number;
    };
}
interface CreateMeetingResult {
    /**
     * Application-facing room id, either the one passed in or the generated fallback.
     *
     * Returned because attach() validates it against the room_id in the authoritative
     * snapshot: without it a caller has to guess, and guessing the room *instance* id fails
     * with "Public Edge returned an invalid room snapshot."
     */
    roomId: string;
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