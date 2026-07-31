export class HellaveApiError extends Error {
    status;
    code;
    retryable;
    context;
    constructor(response) {
        super(response.message ?? `HTTP ${response.status}`);
        this.name = "HellaveApiError";
        this.status = response.status;
        this.code = response.code ?? "unknown";
        this.retryable = response.retryable ?? false;
        this.context = response.context ?? undefined;
    }
}
async function parseJson(res) {
    const body = await res.json();
    if (!res.ok) {
        const code = body["code"];
        const message = body["message"];
        const retryable = body["retryable"];
        const context = body["context"];
        throw new HellaveApiError({
            status: res.status,
            ...(code !== undefined && { code }),
            ...(message !== undefined && { message }),
            ...(retryable !== undefined && { retryable }),
            ...(context !== undefined && { context }),
        });
    }
    // Responses are snake_case on the wire; the declared result types are camelCase. Without
    // this, fields like `room_instance_id` never populate `roomInstanceId` and reads return
    // undefined — which produced request URLs containing "undefined".
    return toCamelCase(body);
}
/**
 * Convert object keys to snake_case for the wire format, recursing through nested
 * objects and arrays.
 *
 * The backend deserializes into plain snake_case Rust structs with no serde aliases, so a
 * shallow conversion leaves nested payloads — `policy`, `profile`, `capabilities` — in
 * camelCase and the request is rejected with "request body is invalid".
 */
function toSnakeCase(value) {
    if (Array.isArray(value)) {
        return value.map((item) => toSnakeCase(item));
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
        const snake = key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
        result[snake] = toSnakeCase(nested);
    }
    return result;
}
/**
 * Convert wire keys back to camelCase, recursing through nested objects and arrays.
 *
 * Mirror of {@link toSnakeCase} for the response direction. JWK members and error bodies
 * contain no underscores, so this is a no-op for them.
 */
function toCamelCase(value) {
    if (Array.isArray(value)) {
        return value.map((item) => toCamelCase(item));
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
        const camel = key.replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
        result[camel] = toCamelCase(nested);
    }
    return result;
}
function defaultParticipantCapabilities(role) {
    const isHost = role === "host";
    return {
        publishAudio: true,
        publishVideo: true,
        shareScreen: true,
        sendMessages: true,
        moderateLobby: isHost,
        moderateParticipants: isHost,
        setSpotlight: isHost,
        controlRecording: isHost,
        updateProfile: true,
    };
}
export class HellaveApiClient {
    #baseUrl;
    #apiKey;
    constructor(opts) {
        this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.#apiKey = opts.apiKey;
    }
    #headers() {
        return {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
        };
    }
    async createRoomInstance(params, idempotencyKey) {
        const res = await fetch(`${this.#baseUrl}/v1/room-instances`, {
            method: "POST",
            headers: { ...this.#headers(), "Idempotency-Key": idempotencyKey },
            body: JSON.stringify(toSnakeCase(params)),
        });
        return parseJson(res);
    }
    async destroyRoomInstance(roomInstanceId) {
        const res = await fetch(`${this.#baseUrl}/v1/room-instances/${encodeURIComponent(roomInstanceId)}`, { method: "DELETE", headers: this.#headers() });
        if (!res.ok) {
            await parseJson(res);
        }
    }
    async issueMeetingToken(roomInstanceId, params) {
        const res = await fetch(`${this.#baseUrl}/v1/room-instances/${encodeURIComponent(roomInstanceId)}/meeting-tokens`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify(toSnakeCase(params)),
        });
        return parseJson(res);
    }
    async createMeeting(params) {
        const roomId = params.roomId ?? crypto.randomUUID().slice(0, 8);
        const expiresAt = Math.floor(Date.now() / 1000) + (params.expiresInSeconds ?? 3600);
        const role = params.role ?? "participant";
        const instance = await this.createRoomInstance({
            roomId,
            expiresAt,
            policy: {
                lobbyEnabled: false,
                maxParticipants: 50,
                maxActiveVideoPublications: 10,
                reconnectGraceSeconds: 300,
            },
        }, crypto.randomUUID());
        const token = await this.issueMeetingToken(instance.roomInstanceId, {
            peerId: params.peerId,
            sessionId: crypto.randomUUID(),
            profile: {
                displayName: params.displayName,
                avatarUrl: params.avatarUrl ?? null,
            },
            role,
            capabilities: defaultParticipantCapabilities(role),
            lobby: params.lobby ?? false,
        });
        return {
            roomInstanceId: instance.roomInstanceId,
            token: token.token,
            expiresAt: token.expiresAt,
        };
    }
    async getJwks() {
        const res = await fetch(`${this.#baseUrl}/.well-known/jwks.json`);
        return parseJson(res);
    }
    async healthCheck() {
        try {
            const res = await fetch(`${this.#baseUrl}/healthz`);
            return { ok: res.ok };
        }
        catch {
            return { ok: false };
        }
    }
}
//# sourceMappingURL=index.js.map