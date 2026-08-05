# Hellave SDK production integration

Hellave uses short-lived Meeting Tokens as capability credentials. A customer backend
authenticates its user, explicitly creates or resolves a durable Room Instance, requests
an instance-bound token from Hellave with a backend-only API key, and returns that token
to its browser through its own authenticated endpoint. Hellave signs Meeting Tokens with
ES256 and publishes retained public verification keys at `/.well-known/jwks.json`; the
browser never receives a Hellave API key or private signing key.

## Quickstart

Install the browser SDK in your web application:

```bash
npm i @hellave/js-sdk
```

One backend process (which you already authenticate) creates or resolves a Room Instance
and issues an instance-bound Meeting Token per signed-in user, exactly as shown in
[Backend token issuance](#backend-token-issuance):

```ts
import { HellaveApiClient } from "@hellave/js-sdk/server";

const api = new HellaveApiClient({
  baseUrl: process.env.HELLAVE_BASE_URL ?? "https://hellave-api.maiaddy.com",
  apiKey: process.env.HELLAVE_BACKEND_API_KEY,
});

// Create a Room Instance once per meeting lifecycle (idempotent with a retry key).
const instance = await api.createRoomInstance(
  { roomId: "room-123", policy: { lobbyEnabled: true, maxParticipants: 50 } },
  crypto.randomUUID(),
);

// Issue one Meeting Token per authorized participant for that instance.
const { token } = await api.issueMeetingToken(instance.roomInstanceId, {
  peerId: "user-456",
  sessionId: crypto.randomUUID(),
  profile: { displayName: "Ada" },
  role: "participant",
  capabilities: {
    publishAudio: true, publishVideo: true, shareScreen: true,
    sendMessages: true, updateProfile: true,
    moderateLobby: false, moderateParticipants: false,
    setSpotlight: false, controlRecording: false,
  },
  lobby: true,
});
```

Then attach in the browser and publish microphone audio:

```ts
import { HellaveClient } from "@hellave/js-sdk";

const client = new HellaveClient({
  controlUrl: "https://hellave-api.maiaddy.com",
  tokenProvider: async ({ roomId, signal }) => {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/token`, {
      method: "POST", signal, credentials: "include",
    });
    if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
    return res.json();
  },
});

const conference = await client.attach({ roomId: "room-123", roomInstanceId: instance.roomInstanceId });
// Wait for admission, then publish.
conference.on("admitted", () => {
  conference.publishMicrophone({ echoCancellation: true });
});
```

That is the whole core. The sections below walk through each piece in production detail:
backend token issuance, browser attachment and session semantics, media publication,
remote reception, lobby moderation, messaging and presence, recording, spotlight,
subscription, diagnostics, and the complete public API reference. If you operate the
Hellave service yourself rather than consuming a hosted edge, the deployment section at
the end of this document applies to you. If you are porting the SDK to another language
(Python, Flutter/Dart, and so on) instead of consuming it, the wire contract in
[`docs/contract.md`](contract.md) is the language-neutral protocol you implement.

## If you operate Hellave yourself: production prerequisites

- Expose the Public Edge origin through HTTPS and `/v1/control` through WSS. Do not
  expose the prototype raw `/ws` route to SDK consumers.
- Expose every advertised SFU HTTP origin through HTTPS.
- Route SFU UDP media and configured STUN/TURN ports publicly.
- Configure `HELLAVE_CORS_ALLOWED_ORIGINS` with exact application origins.
- Store `HELLAVE_SIGNALING_TOKEN_SECRET`, backend API keys, the control-database password,
  and the Meeting Token keyring in a secrets manager.
- Store a separate `HELLAVE_SFU_CONTROL_SECRET` for private signaling-to-SFU moderation.
- Keep the orchestrator and Redis private.

> **E2EE is not currently available.** Hellave uses WebRTC transport encryption, but the
> SDK does not yet encrypt encoded media frames with application-held keys. The SFU can
> process media, so applications must not describe current rooms as end-to-end encrypted.
> A complete fail-closed, application-keyed E2EE feature is planned for a later release.

The Public Edge is deployed at `https://hellave-api.maiaddy.com` with
TLS termination and WebSocket proxy. All SDK control traffic goes through
this single origin.

## Backend token issuance

Consumers call the hosted Public Edge; the deployment env vars below are what an
operator of the signaling service would set (see
[If you operate Hellave yourself](#if-you-operate-hellave-yourself-production-prerequisites)).
Configure the signaling/API-gateway service:

```dotenv
HELLAVE_SIGNALING_TOKEN_SECRET=<at-least-32-random-bytes>
HELLAVE_SFU_CONTROL_SECRET=<different-at-least-32-random-bytes>
HELLAVE_MEETING_TOKEN_API_KEYS=org-123=<backend-api-key>
HELLAVE_CONTROL_DATABASE_URL=postgres://hellave_control:<password>@postgres:5432/hellave_control
HELLAVE_MEETING_TOKEN_KEYRING_PATH=/run/secrets/meeting-token-keyring.json
HELLAVE_MEETING_TOKEN_TTL_SECS=300
HELLAVE_MEETING_TOKEN_ISSUER=hellave
HELLAVE_MEETING_TOKEN_AUDIENCE=hellave-conference
HELLAVE_ORCHESTRATOR_URL=http://orchestrator:4100
HELLAVE_PUBLIC_SFU_SCHEME=https
HELLAVE_CORS_ALLOWED_ORIGINS=https://app.example.com
```

For the production multi-SFU Compose deployment, also configure the public origins that
the orchestrator is allowed to advertise to browsers:

```dotenv
HELLAVE_SFU_A_PUBLIC_HOST=sfu-a.example.com
HELLAVE_SFU_A_PUBLIC_HTTPS_PORT=443
HELLAVE_SFU_B_PUBLIC_HOST=sfu-b.example.com
HELLAVE_SFU_B_PUBLIC_HTTPS_PORT=443
```

Each hostname must terminate TLS for its SFU HTTP service and resolve to the public IP
used by that node's advertised UDP media address.

The keyring file is secret JSON with one active key and any previous keys that must
verify unexpired tokens:

```json
{
  "active_kid": "meeting-key-2026-07",
  "keys": [
    {
      "kid": "meeting-key-2026-07",
      "private_key_pem": "-----BEGIN PRIVATE KEY-----\n<PKCS8 P-256 key>\n-----END PRIVATE KEY-----\n"
    }
  ]
}
```

Rotate by adding the new private key, changing `active_kid`, and retaining the previous
entry until every token it signed has expired. Services validate through the public JWKS
material, not by sharing the private key. `HELLAVE_SIGNALING_TOKEN_SECRET` remains a
separate internal secret for post-admission Media Capabilities.

The organization is derived from the API key mapping; callers cannot choose another
organization in a request body. Construct a single `HellaveApiClient` from
`@hellave/js-sdk/server` once and use it for every backend call. First, the Application
Backend explicitly creates or idempotently resolves a Room Instance:

```ts
import { HellaveApiClient } from "@hellave/js-sdk/server";

const api = new HellaveApiClient({
  baseUrl: process.env.HELLAVE_BASE_URL ?? "https://hellave-api.maiaddy.com",
  apiKey: process.env.HELLAVE_BACKEND_API_KEY,
});

// Create or idempotently resolve a Room Instance.
const instance = await api.createRoomInstance(
  {
    roomId: "room-123",
    expiresAt: 1785369600,
    policy: {
      lobbyEnabled: true,
      maxParticipants: 50,
      maxActiveVideoPublications: 10,
      reconnectGraceSeconds: 300,
    },
  },
  crypto.randomUUID(),
);
console.log(instance.roomInstanceId);
```

The response contains a unique `roomInstanceId` (sent on the wire as `room_instance_id`).
Reusing the same application-facing `roomId` in a later lifecycle creates a different
instance; retries with the same idempotency key and identical input return the original
instance.

The expiry is a fixed terminal boundary. To end an instance earlier, the Application
Backend—not browser code—destroys it idempotently:

```ts
// Destroy an instance early (idempotent).
await api.destroyRoomInstance(instance.roomInstanceId);
```

Expiry and destruction close active memberships, revoke the instance's credentials, and
make later token issuance or attachment fail permanently. Create a new Room Instance and
issue fresh Meeting Tokens to reuse the application-facing `roomId` for another meeting.

After authenticating and authorizing a user, request a token for that exact instance:

```ts
// Issue an instance-bound Meeting Token after authorizing a user.
const token = await api.issueMeetingToken(instance.roomInstanceId, {
  peerId: "user-456",
  sessionId: "browser-session-1",
  profile: { displayName: "Ada", avatarUrl: "https://app.example.com/avatars/user-456.png" },
  role: "participant",
  capabilities: {
    publishAudio: true,
    publishVideo: true,
    shareScreen: true,
    sendMessages: true,
    moderateLobby: false,
    moderateParticipants: false,
    setSpotlight: false,
    controlRecording: false,
    updateProfile: true,
  },
  lobby: true,
});
```

The response is non-cacheable; the SDK returns it as `token`, `tokenType`, `expiresIn`,
and `expiresAt`. Role supplies defaults and display meaning; the explicit capability
object is the maximum authority Hellave may grant and cannot exceed that role's ceiling.

The client sends every request body in snake_case and decodes snake_case responses, so
request fields like `lobbyEnabled` are written as `lobby_enabled` on the wire and response
fields like `roomInstanceId` are read back from `room_instance_id`. For reference, the raw
HTTP endpoints under the Public Edge (`https://hellave-api.maiaddy.com`) are:

| Endpoint | Auth | Idempotency-Key | Response |
| --- | --- | --- | --- |
| `POST /v1/room-instances` | `Authorization: Bearer <backend-api-key>` | required | `room_instance_id`; `201 Created` on create, `200 OK` on idempotent replay |
| `DELETE /v1/room-instances/{room_instance_id}` | `Authorization: Bearer <backend-api-key>` | not required | idempotent (no response body) |
| `POST /v1/room-instances/{room_instance_id}/meeting-tokens` | `Authorization: Bearer <backend-api-key>` | not required | `token`, `token_type`, `expires_in`, `expires_at` |
| `GET /.well-known/jwks.json` | none (public verification keys) | — | retained ES256 public keys |
| `GET /healthz` | none | — | liveness; `ok` |

Retrying `POST /v1/room-instances` with the same `Idempotency-Key` and identical input
returns the original `room_instance_id` (`200 OK`) instead of creating a second instance.

Every server-SDK method throws `HellaveApiError` on a non-2xx response, exposing `status`,
`code`, `retryable`, and bounded `context`. The client does not wrap transport failures:
only `healthCheck()` catches a failed `fetch` and returns `{ ok: false }`; every other
method lets the underlying `fetch` error (for example a `TypeError`) propagate as-is. The
shipped client does not emit a `code: "network_error"` on transport loss.

Example application endpoint, constructing `HellaveApiClient` once at server startup and
reusing it per request:

```ts
const api = new HellaveApiClient({
  baseUrl: process.env.HELLAVE_BASE_URL ?? "https://hellave-api.maiaddy.com",
  apiKey: process.env.HELLAVE_BACKEND_API_KEY,
});

app.post("/api/rooms/:roomId/token", requireSignedInUser, async (req, res) => {
  const roomInstance = await resolveAuthorizedRoomInstance(req.params.roomId);
  const token = await api.issueMeetingToken(roomInstance.id, {
    peerId: req.user.id,
    sessionId: req.session.id,
    profile: {
      displayName: req.user.displayName,
      avatarUrl: req.user.avatarUrl,
    },
    role: await roleFor(req.user.id, req.params.roomId),
    capabilities: await capabilitiesFor(req.user.id, req.params.roomId),
    lobby: roomInstance.policy.lobbyEnabled,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json(token);
});
```

## Browser waiting attachment

The SDK calls `tokenProvider` on first attach and again on every reconnect and recovery
refresh, so the callback must mint a fresh short-lived Meeting Token each time — never
return the captured token from the initial attach. Mint every token for one conference
under a single `sessionId`: the server treats a token bearing the *same* session as a
reconnect and replaces the old attachment, while the same peer arriving on a *different*
session is refused outright with `"peer_id is already connected in this room"`. A fresh
UUID per refresh therefore turned every reconnect into a dead session.

```ts
import { HellaveClient } from "@hellave/js-sdk";

// One session for the whole conference, reused by every mint.
const sessionId = crypto.randomUUID();

const client = new HellaveClient({
  controlUrl: "https://hellave-api.maiaddy.com",
  tokenProvider: async (context) => {
    const response = await fetch(`/api/rooms/${encodeURIComponent(context.roomId)}/token`, {
      method: "POST",
      credentials: "include",
      signal: context.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomInstanceId: context.roomInstanceId,
        // Only the first attach to a conference may wait for admission. A reconnect or a
        // refresh is already past the lobby, and asking again would send the person back
        // to waiting.
        lobby: context.reason === "attach",
        sessionId,
      }),
    });
    if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
    const { token } = await response.json();
    return { token };
  },
});

const conference = await client.attach({
  roomId: "room-123",
  roomInstanceId: "018f47a0-7b2c-7d4e-8d11-111111111111",
});

console.log(conference.state); // "waiting"
console.log(conference.localParticipant.profile.displayName);
console.log(conference.snapshot.revision);
```

The SDK opens `wss://hellave-api.maiaddy.com/v1/control`, negotiates Contract Release and
protocol compatibility, and only then invokes `tokenProvider`. The callback receives the
`TokenProviderContext` below and returns a structured `{ token }`; the SDK treats that
value as an opaque, memory-only credential and never decodes JWT claims. Its
`AbortSignal` is cancelled when attachment is aborted or closed.

```ts
interface TokenProviderContext {
  roomId: string;
  roomInstanceId: string;
  reason: "attach" | "refresh" | "reconnect";
  priorSessionId?: string;
  signal: AbortSignal;
}
```

`reason` tells the browser which mint this is. The first attach to a conference is
`"attach"` — the only time a lobby request is meaningful, so pass `lobby: true` only then.
Transport recovery mints with `"refresh"`, and a replaced media session mints with
`"reconnect"`; both are already past the lobby, so requesting lobby placement again would
send the person back to waiting. `priorSessionId`, when present, is the session Hellave is
replacing.

Contract Release 0.6.0 keeps waiting attachment deliberately bounded: it creates no
media device prompt or peer connection. When admitted, the same `Conference` retains
its short-lived Media Capability privately and can publish media without
exposing placement, SFU participant IDs, SDP, ICE, senders, or transceivers.

## Media publication

Each publish method captures a media source and reserves an idempotent stable
publication on Hellave before WebRTC binding. Call any of them only after
`conference.state === "admitted"`.

### Microphone

Call `publishMicrophone()` only after `conference.state === "admitted"`. The browser
prompts for microphone access, Hellave reserves an idempotent stable publication, and
the SDK negotiates WebRTC over the existing authenticated control connection.

```ts
const microphone = await conference.publishMicrophone({
  echoCancellation: true,
  noiseSuppression: true,
});

console.log(microphone.id); // stable Hellave publication identity
console.log(microphone.ownerParticipantId);
console.log(microphone.source); // "microphone"

conference.on("remoteMicrophoneTrack", (remote) => {
  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = new MediaStream([remote.mediaStreamTrack]);
  document.body.append(audio);

  console.log(remote.publicationId);
  console.log(remote.ownerParticipantId);
});

await microphone.stop();
```

`publishMicrophone()` rejects before admission, when `publishAudio` is false, when
capture fails, or when the bounded reservation/negotiation cannot complete. On failure
the SDK stops the captured track and Hellave releases the reservation. `stop()` is
idempotent and resolves only after the SFU stops forwarding before releasing capacity.
The SDK uses trickle ICE immediately; applications do not wait for full ICE gathering
or call SFU endpoints themselves.

### Camera and screen publication

```ts
// Camera: capture and publish in one call. Rejects before admission, when
// publishVideo is false, or when capture fails.
const camera = await conference.publishCamera({ width: 1280, height: 720 });

// Screen: the browser's own picker decides what is shared; rejects if the
// user dismisses it.
const screen = await conference.publishScreen();
```

`MediaPublication.source` is `"microphone" | "camera" | "screen" | "screen_audio"`. A
second camera or screen publication rejects with `conflict` until the first is
stopped; a second microphone publication instead replaces the captured track, keeping
the same stable `MediaPublication`. The returned `MediaPublication` exposes no capture
track — use the media device controller for a local self-view.

### Media device controller

`conference.mediaDeviceController` separates capture from publication, so an
application can preview a local camera, switch a live publication to another device,
route remote audio to a specific output, or enumerate the available inputs and outputs.

```ts
const controller = conference.mediaDeviceController;

// Preview a camera for a local self-view without publishing it.
const [capture] = await controller.capturePreview({ audio: false, video: true });
selfViewEl.srcObject = new MediaStream([capture.mediaStreamTrack]);

// Publish the captured track under a stable identity.
await controller.publishCapture(capture);

// Switch the input device on an owned publication.
await controller.switchDevice(camera, { deviceId: "other-camera-id" });

// Route remote audio to a specific output device.
await controller.setSinkId(audioEl, "speaker-id");

// Enumerate inputs/outputs.
const inputs = await controller.enumerateAudioInputs();

// Current local publications by source.
const { camera: c, screen: s, microphone: m } = controller.activePublications;
```

### CaptureTrack

`capturePreview` returns an array of `CaptureTrack` and `captureScreen` a single
`CaptureTrack`, a wrapper over a native
`MediaStreamTrack`. It exposes the immutable `source`, the underlying
`mediaStreamTrack`, a participant-private `muted` flag, `ownership` (`"sdk"` or
`"application"`), and an `ended` flag. Call `mute()` / `unmute()` to stop or resume
sending on the live track, `stop()` to release it, or `replaceTrack(track)` to swap
the underlying native track. `CaptureTrack` emits `ended` when the browser ends the
track and `muteChanged` with the new muted boolean. `captureScreen` sets
`contentHint = "detail"` so the encoder prioritizes the legibility of shared text.

### Remote video reception

`conference.on("remoteVideoTrack", ...)` fires for every camera and screen-share track
Hellave forwards to this participant. Substitute `tiles` with your own map from
publication ID to its `HTMLVideoElement`:

```ts
conference.on("remoteVideoTrack", (remote) => {
  const video = document.createElement("video");
  video.autoplay = true;
  video.srcObject = new MediaStream([remote.mediaStreamTrack]);
  tiles.set(remote.publicationId, video);
  document.body.append(video);

  console.log(remote.publicationId);
  console.log(remote.ownerParticipantId);

  // The Public Edge sends no stop message, so clear the element on ended,
  // otherwise the last decoded frame stays on screen. A track only goes
  // "mute" when forwarding is merely paused, and that one comes back.
  remote.mediaStreamTrack.addEventListener("ended", () => {
    video.remove();
    tiles.delete(remote.publicationId);
  });
});
```

`RemoteVideoTrack` carries `publicationId` and `ownerParticipantId` but no `source`, so
the emitted handler cannot tell a camera tile from a screen share by the track alone.
A consumer that renders both must map `publicationId → source` from
`conference.snapshot.publications` (each entry carries `id` and `source`) to distinguish
them. The playground keys tiles by publication, so a camera and a screen share coexist
for one participant without overwriting each other.

## Lobby admission and denial

A participant whose explicit `moderateLobby` capability is true receives waiting
identities and bounded profiles in `conference.snapshot.lobby`. A `host` role string
without that capability cannot observe or mutate the lobby.

```ts
conference.on("snapshotChanged", (snapshot) => {
  renderLobby(snapshot.lobby);
});

const waitingParticipant = conference.snapshot.lobby[0];
if (waitingParticipant) {
  const result = await conference.admit(waitingParticipant.id);
  console.log("committed revision", result.revision);
}

// Or deny, optionally with a bounded server-private reason:
await conference.deny("user-789", "Not on the invitation list");
```

`admit()` and `deny()` resolve only after the Public Edge acknowledges the committed
room revision. They reject with `HellaveError` when the caller lacks the explicit
capability, the participant is no longer waiting, input is invalid, or the command
cannot be committed.

A waiting participant observes admission without re-attaching:

```ts
conference.on("admitted", () => {
  console.log(conference.state); // "admitted"
});

conference.on("denied", (error) => {
  console.log(conference.state); // "denied"
  console.log(error.code); // "authorization_denied"
});

conference.on("error", (error) => {
  // For example, an expired Meeting Token terminates a waiting attachment.
  console.log(conference.state); // "failed"
  console.log(error.code); // "authentication_failed"
});
```

Denial and post-attachment authentication failure are terminal. `client.conference`
becomes `null`; obtain fresh application authorization and a fresh Meeting Token before
starting another attachment. The denial reason supplied by the moderator is not exposed
to the denied browser.

## Messaging and presence

Chat messages, reactions, and raised hands are transient room events: Hellave never
stores or replays them, so a late joiner sees only messages, reactions, and hands
raised from the point of their attachment onward.

```ts
conference.sendMessage("Hello everyone");

conference.on("roomMessage", (message) => {
  console.log(message.fromParticipantId, message.body, message.sentAt);
});

conference.sendReaction("thumbs_up");

conference.on("reactionReceived", (reaction) => {
  console.log(reaction.fromParticipantId, reaction.reaction, reaction.sentAt);
});

conference.setHandRaised(true);

conference.on("handRaisedChanged", (participantId, raised) => {
  console.log(conference.raisedHands); // ReadonlySet<string>
});
```

`sendMessage` and `sendReaction` require the `sendMessages` capability; `setHandRaised`
does not. `RoomMessage` carries `fromParticipantId`, `body`, and `sentAt` (a Unix
timestamp in seconds); `ReceivedReaction` carries `fromParticipantId`, `reaction`,
and `sentAt`. Raised hands are ephemeral event state, not snapshot fields:
`conference.raisedHands` is a `ReadonlySet<string>` of participant IDs whose hands
are currently raised, and a late joiner sees only hands raised from that point on.

## Recording

`startRecording()` and `stopRecording()` drive room-wide recording and both require the
`controlRecording` capability. Any host may stop a recording another host started.
`startRecording()` resolves with the recording identity (or `null`), and
`conference.recording` reflects the latest committed state.

```ts
const recordingId = await conference.startRecording();
console.log(conference.recording); // { active: true, recordingId }

conference.on("recordingChanged", (active, recordingId) => {
  console.log(active, recordingId);
});

await conference.stopRecording();
```

## Spotlight and subscription policy

`setSpotlight(publicationId, options?)` sets or clears the room-wide Spotlight video
publication and requires the `setSpotlight` capability. `conference.spotlight`
returns the current Spotlight publication ID, or `null` when none is active. `pin()`
and `unpin()` update the participant's private high-priority subscription list; all
other subscription routing is decided by the server.

```ts
// Requires the setSpotlight capability.
await conference.setSpotlight(publicationId);

// Pin a publication to the local high-priority subscription list.
await conference.pin(publicationId);

// Reset to server-default subscription routing.
await conference.unpin();

await conference.setSubscriptionPolicy({ preferredVideoLayer: "high" });

conference.on("spotlightChanged", (publicationId) => {
  console.log(conference.spotlight); // publicationId or null
});
```

`SubscriptionPolicy` accepts `audioEnabled`, `videoEnabled`, `maxVideoConsumers`,
`pinnedPublications`, and `preferredVideoLayer` (`"low"` | `"medium"` | `"high"`).

## Diagnostics and connection quality

`requestDiagnostics()` resolves with a `ClientDiagnostics` snapshot of the active media
path, and `conference.connectionQuality` reflects the latest overall quality,
pushed through `connectionQualityChanged`.

```ts
const diagnostics = await conference.requestDiagnostics();
console.log(diagnostics.rtt, diagnostics.jitter, diagnostics.packetLoss);
console.log(diagnostics.candidateType, diagnostics.protocol, diagnostics.quality);

conference.on("connectionQualityChanged", (quality) => {
  console.log(quality); // "excellent" | "good" | "fair" | "poor" | "failed"
});
```

`ClientDiagnostics` also carries `bitrate` and `timestamp` alongside `rtt`, `jitter`,
`packetLoss`, `candidateType`, `protocol`, and `quality`. The playground polls
`requestDiagnostics()` on an interval and surfaces `candidateType` / `protocol`
(e.g. `relay/tcp` reveals TURN usage) and `quality`.

## Public API

### `HellaveClient`

The browser entry point for stable Hellave domain operations.

| Member | Purpose |
| --- | --- |
| `attach(options: AttachOptions)` | Negotiate compatibility, acquire an opaque Meeting Token, and attach to an existing Room Instance. |
| `leave()` | Commit and acknowledge terminal membership leave, then close the Public Edge attachment. |
| `conference` | Current `Conference`, or `null`. |

`HellaveConfig`:

| Field | Purpose |
| --- | --- |
| `controlUrl` | Public HTTPS Hellave origin; the SDK opens `wss://<origin>/v1/control`. |
| `tokenProvider` | Callback minting a fresh short-lived Meeting Token for every attach, refresh, and reconnect. |
| `attachTimeoutMs` | Bounds each individual control attempt; defaults to `10_000`. |
| `recoveryBudgetMs` | Total time allowed for automatic transient recovery; defaults to `120_000`. |

`AttachOptions`:

| Field | Purpose |
| --- | --- |
| `roomId` | Application-facing Room ID, validated against the authoritative snapshot. |
| `roomInstanceId` | Server-issued durable Room Instance ID. |
| `signal?` | Optional `AbortSignal` cancelling the attachment. |

`HellaveConfig.recoveryBudgetMs` bounds automatic transient recovery and defaults to
120,000 milliseconds. `attachTimeoutMs` bounds each individual control attempt; it does
not replace the overall Recovery Budget.

### `Conference`

| Member | Purpose |
| --- | --- |
| `state` | Current lifecycle state: `"waiting"`, `"admitted"`, transient `"degraded"` / `"reconnecting"`, or terminal `"denied"`, `"failed"`, and `"left"`. |
| `roomId`, `roomInstanceId` | Server-confirmed public room identities. |
| `localParticipant` | Server-authorized identity, profile, role, and capability ceiling. |
| `snapshot` | Latest immutable role-scoped room view with a monotonic revision, stable `participants`, and active `publications`; `lobby` is populated only for explicit lobby moderators. |
| `publicationIntents` | Inactive stable local publication identities retained by an eligible same-session reconnect; the next matching publish reuses the identity. |
| `negotiated` | Selected Contract Release, protocol, and deployment capabilities. |
| `terminalError` | Typed terminal `HellaveError` after denial or failure; otherwise `null`. |
| `expiresAt` | Fixed Unix expiry after the Public Edge announces it; otherwise `null`. |
| `spotlight` | Current room-wide Spotlight publication ID, or `null` when none is active. |
| `raisedHands` | `ReadonlySet<string>` of participant IDs whose hands are currently raised; ephemeral event state, not snapshot fields. |
| `recording` | Latest committed recording state as `{ active, recordingId }`. |
| `connectionQuality` | Latest overall media-path quality: `"excellent"` \| `"good"` \| `"fair"` \| `"poor"` \| `"failed"`. |
| `mediaDeviceController` | Separates capture from publication for previews, device switching, output sinks, and enumeration. |
| `publishMicrophone(constraints?, options?)` | Capture and publish microphone audio with an optional stable `commandId`; when already publishing, replaces the captured track and returns the same stable `MediaPublication`. |
| `publishCamera(constraints?, options?)` | Capture and publish a camera through `mediaDeviceController.capturePreview`. |
| `publishScreen(displayOptions?, options?)` | Capture and publish a screen share through the browser's own picker. |
| `sendMessage(body)` | Send a chat message; requires the `sendMessages` capability. |
| `sendReaction(reaction)` | Send a transient reaction; requires the `sendMessages` capability. |
| `setHandRaised(raised)` | Raise or lower this participant's hand; requires no capability. |
| `startRecording(commandId?)` | Start room-wide recording; requires `controlRecording`. Resolves with the recording identity or `null`. |
| `stopRecording(commandId?)` | Stop the room's recording; any host may stop what another host started. |
| `setSpotlight(publicationId, options?)` | Set or clear the room-wide Spotlight video publication; requires `setSpotlight`. |
| `setSubscriptionPolicy(policy, options?)` | Update the participant's private SFU subscription policy. |
| `pin(...publicationIds)` | Raise one or more publication IDs to high priority in the local subscription policy. |
| `unpin()` | Remove publication priority preferences and reset to server-default subscription routing. |
| `setPublishBlock(participantId, mediaKind, blocked, options?)` | Host-only acknowledged audio/video Publish Block; SFU enforcement succeeds before the Room Command commits. |
| `requestDiagnostics()` | Resolve with a `ClientDiagnostics` snapshot of the active media path. |
| `retry()` | Explicitly restart recovery only after the configured Recovery Budget was exhausted. |
| `leave()` | Commit and acknowledge terminal membership leave idempotently. |
| `admit(participantId, options?)` | Capability-checked lobby admission; accepts an optional stable `commandId` and resolves with that ID plus the committed revision. |
| `deny(participantId, reason?, options?)` | Capability-checked terminal denial with the same idempotent command behavior. |

`Conference` emits exactly eighteen events: `stateChanged`, `snapshotChanged`, `admitted`,
`denied`, `error`, `roomExpiring`, `left`, `publicationAdded`, `remoteMicrophoneTrack`,
`remoteVideoTrack`, `localMuteChanged`, `publishBlockChanged`, `spotlightChanged`,
`connectionQualityChanged`, `roomMessage`, `handRaisedChanged`, `reactionReceived`, and
`recordingChanged`. `roomExpiring` receives the fixed Unix expiry and does not mean the
expiry is extendable. Subscribe before rendering asynchronous lifecycle or media changes.

When the Room Instance expires or the Application Backend destroys it, the Conference
transitions to `"failed"`, `terminalError.code` is `"resource_not_found"`, and
`terminalError.context.reason` is `"expired"` or `"destroyed"`. The SDK closes the
attachment and clears `client.conference`; old Meeting Tokens and Media Capabilities must
not be retried. An ordinary empty room is different: Hellave may unload its actor and SFU
placement, then transparently establish fresh fenced generations on a later authorized
attachment to the same still-active Room Instance.

`snapshot` is the sole room-state authority. After the exact attachment snapshot, the
SDK applies only ordered `room_delta` changes whose base is the currently committed
Room Revision. A duplicate, stale, or skipped revision causes one bounded private resynchronization
request; no roster, moderation, lobby, or publication mutation is guessed from an event
or command acknowledgement. Existing `RoomParticipant` and `MediaPublication` objects
are reconciled in place, so transport or media-session replacement does not break
application object identity. Ordinary participants always receive an empty `lobby`.
Every `RoomParticipant` exposes stable `id`, current `profile`, `role`, `capabilities`,
and server-enforced `publishBlocked.audio` / `publishBlocked.video` state. Publish Block
prevents media at the SFU boundary. Clearing it restores permission only: it never starts
capture, enables a track, or changes participant-private Local Mute.

`leave()` is not a local socket shortcut. It resolves after Hellave has stopped owned
media, removed membership through an authoritative revision, and revoked that meeting
session. If its acknowledgement is lost, the promise rejects with a typed unknown
outcome; the SDK never reports a leave it did not observe. Unexpected transport loss is
different: Hellave retains eligible participant and publication intent only for the
room's bounded reconnect grace, and a same-session replacement receives a fresh,
stale-command-fencing attachment generation.

Control loss does not close a healthy WebRTC connection. The Conference becomes
`"degraded"` while the SDK obtains a reconnect Meeting Token, replaces the fenced control
attachment, reconciles the authoritative snapshot and retained publication intent without
renegotiating a healthy peer connection. A failed media path becomes `"reconnecting"`;
the SDK attempts one same-session ICE restart first, then refreshes authorization and
replaces the Media Session if necessary. Participant, Conference, capture track, and
Media Publication identities remain stable throughout successful recovery.
Authentication or authorization loss is terminal. Budget exhaustion produces a retryable
`HellaveError` with `context.reason === "recovery_budget_exhausted"`; the application must
call `conference.retry()` explicitly.

For any lobby, publish, or stop mutation whose outcome must survive a retry, generate a
stable command ID in your application and reuse it only for identical input:

```ts
const commandId = crypto.randomUUID();
try {
  await conference.admit(participantId, { commandId });
} catch (error) {
  // context.outcome === "unknown" means wait for snapshot reconciliation,
  // then retry this same command ID to resolve the durable result.
}
```

The same option is accepted by
`conference.publishMicrophone(true, { commandId })` and
`publication.stop({ commandId })`. Never run two commands concurrently with the same
ID. If a retryable error has `context.outcome === "unknown"`, wait for the SDK's
authoritative snapshot reconciliation before retrying. During `"degraded"` or
`"reconnecting"`, wait for recovery to complete. If automatic recovery exhausts its
budget, call `conference.retry()`. A deterministic
rejection is replayed unchanged, while a successful replay resolves with the original
committed Room Revision. Caller-owned publications in a replacement snapshot remain
stoppable with `publication.stop({ commandId })`.

### `MediaPublication`

| Member | Purpose |
| --- | --- |
| `id` | Stable server-authoritative publication identity. |
| `ownerParticipantId` | Stable owning Room Participant ID. |
| `source` | `"microphone"` \| `"camera"` \| `"screen"` \| `"screen_audio"`. |
| `state` | `"active"` or `"stopped"`. |
| `localMuted` | Participant-private boolean controlling the owned capture track; it is independent from host Publish Block. |
| `setLocalMuted(muted)` | Owner-only Local Mute toggle. No host API can clear it or remotely activate the device. |
| `stop(options?)` | Idempotently stop forwarding before releasing publication capacity; accepts an optional stable `commandId`. |

### `RemoteMicrophoneTrack`

| Member | Purpose |
| --- | --- |
| `publicationId` | Stable publication identity associated by Hellave. |
| `ownerParticipantId` | Stable owning Room Participant ID. |
| `mediaStreamTrack` | Native audio track used for browser playback. |

### `RemoteVideoTrack`

| Member | Purpose |
| --- | --- |
| `publicationId` | Stable publication identity associated by Hellave. |
| `ownerParticipantId` | Stable owning Room Participant ID. |
| `mediaStreamTrack` | Native video track used for browser playback. |

### `CaptureTrack`

Captured local media, held independently of any publication so previews do not require publishing.

| Member | Purpose |
| --- | --- |
| `source` | `"microphone"` \| `"camera"` \| `"screen"` \| `"screen_audio"`. |
| `mediaStreamTrack` | Native track backing this capture. |
| `muted` | Participant-private capture mute state. |
| `ownership` | `"sdk"` or `"application"`, signalling whether the SDK or the application controls lifecycle. |
| `ended` | `true` after the native track has ended. |
| `mute()` | Disable the native track and reflect a local mute. |
| `unmute()` | Re-enable the native track and clear the local mute. |
| `stop()` | Stop the native track and release the capture. |
| `replaceTrack(track)` | Swap in a new native track, preserving capture identity. |

### `MediaDeviceController`

Separates capture from publication for previews, device switching, output sinks, and enumeration.

| Member | Purpose |
| --- | --- |
| `capturePreview(constraints)` | Capture preview tracks without publishing them. An empty capture rejects with `invalid_request`. |
| `captureScreen(options?)` | Capture a screen share through the browser picker; returns one `CaptureTrack`. |
| `publishCapture(capture, options?)` | Publish an existing `CaptureTrack`; conflicts when the same source is already published. |
| `switchDevice(publication, constraints?)` | Replace the track behind an owned publication with one from a chosen device. |
| `setSinkId(element, sinkId)` | Route audio output of an `HTMLMediaElement` to a specific device. |
| `enumerateAudioInputs()` | List audio input devices. |
| `enumerateVideoInputs()` | List video input devices. |
| `enumerateAudioOutputs()` | List audio output devices. |
| `enumerateAll()` | Enumerate all devices grouped by kind. |
| `activePublications` | Current locally published `MediaPublication`s keyed by source. |

### `RoomSnapshot`

Immutable role-scoped room view at one authoritative revision.

| Member | Purpose |
| --- | --- |
| `revision` | Monotonic authoritative revision. |
| `roomId` | Application-facing Room ID. |
| `roomInstanceId` | Server-issued durable Room Instance ID. |
| `participants` | `RoomParticipant`s in the room. |
| `publications` | Active `MediaPublication`s. |
| `lobby` | `LobbyParticipant`s awaiting admission; populated only for lobby moderators. |
| `spotlightPublicationId` | Room-wide Spotlight publication ID, or `null`. |

### `RoomParticipant`

| Member | Purpose |
| --- | --- |
| `id` | Stable Room Participant ID. |
| `profile` | `{ displayName, avatarUrl? }` display identity. |
| `role` | `"host"`, `"participant"`, or `"viewer"`. |
| `capabilities` | Server-authorized capability ceiling for publishing, messaging, moderation, spotlight, recording, and profile updates. |
| `muted` | Participant-private mute state `{ audio, video }`. |
| `publishBlocked` | Server-enforced publish policy `{ audio, video }`; independent from Local Mute. |

### `LobbyParticipant`

| Member | Purpose |
| --- | --- |
| `id` | Stable participant ID while waiting in the lobby. |
| `profile` | `{ displayName, avatarUrl? }` display identity. |

### `HellaveError`

| Member | Purpose |
| --- | --- |
| `code` | Stable contract error code; see the table below. |
| `retryable` | Whether a retry is expected to succeed. |
| `context` | Bound structured context, at most 8 primitive entries. |

Contract Release 0.6.0 defines these error codes:

| Code | Retryable | What an integrator should do |
| --- | --- | --- |
| `incompatible_protocol` | No | SDK and Public Edge disagree on Contract Release or protocol range. Upgrade the package or the edge; both must support the same major protocol. |
| `invalid_request` | No | A call or wire message violated the contract (for example an over-long chat message, an unsupported reaction, or a malformed command). Fix the application input; do not retry unchanged. |
| `request_cancelled` | No | The attachment's `AbortSignal` fired or the request was superseded. Surface the cancellation to the user; do not retry the cancelled operation. |
| `authentication_failed` | No | The Meeting Token was invalid, expired, or rejected during negotiation. Mint a fresh token and retry the attachment once. |
| `authorization_denied` | No | The caller lacked the explicit capability for the action, or the moderator denied the waiting participant. Check the role/capability ceiling, or re-enter the lobby for a fresh denial flow. |
| `resource_not_found` | No | The Room Instance was unknown, expired, or destroyed. Inspect `context.reason` (`"expired"` or `"destroyed"`); create a new Room Instance and fresh tokens to resume. |
| `conflict` | No | A mutating command collided: already in flight, unknown after resync, or a second camera/screen publication on the same source. Stop or reuse the existing publication, or retry the same `commandId` after snapshot reconciliation. |
| `capacity_exceeded` | Yes | The room or SFU is full (`maxParticipants`, `maxActiveVideoPublications`). Retry with backoff, or surface that the room is full. |
| `rate_limited` | Yes | Too many requests in the bounded window. Retry with backoff; back off longer if it recurs. |
| `temporarily_unavailable` | Yes | A transient transport or reconciliation failure; `context.outcome === "unknown"` means reconcile the snapshot before retrying the same `commandId`. Retry with backoff. |
| `internal` | No | An internal Hellave failure. Do not retry the same request blindly; report it. |

### Contract Release and protocol

The client targets **Contract Release 0.6.0** at package version **0.5.20**, which supports
protocol **major 1, minor 0**. The selected release and protocol are exposed on
`conference.negotiated`.

### `@hellave/js-sdk/server`

The server-side subpath wraps the backend API for room lifecycle, meeting-token issuance,
and diagnostics. See [Backend token issuance](#backend-token-issuance) for the full
walkthrough. Construct one `HellaveApiClient` at server startup with `baseUrl` and your
backend API key.

`HellaveApiClient`:

| Method | Purpose |
| --- | --- |
| `createRoomInstance(params, idempotencyKey)` | Create or idempotently resolve a Room Instance with an explicit policy and expiry. |
| `destroyRoomInstance(roomInstanceId)` | Idempotently destroy an instance early, revoking memberships and tokens. |
| `issueMeetingToken(roomInstanceId, params)` | Mint an instance-bound Meeting Token for an authorized peer. |
| `createMeeting(params)` | Convenience composing `createRoomInstance` + `issueMeetingToken`; returns `roomId`, `roomInstanceId`, `token`, and `expiresAt`. |
| `getJwks()` | Fetch retained ES256 public verification keys. |
| `healthCheck()` | Liveness probe returning `{ ok }`; never throws. |

Every other method throws `HellaveApiError` on a non-2xx response:

`HellaveApiError`:

| Member | Purpose |
| --- | --- |
| `status` | HTTP status of the failed response. |
| `code` | Stable contract error code, or `"unknown"`. |
| `retryable` | Whether a retry is expected to succeed. |
| `context` | Bounded structured context from the error body. |

## Build a minimal room page

A plain TypeScript ESM module that ties the pieces above into one page: attach, render
the remote tile grid, publish your own camera, and send chat. The server issue-side
(mint a token per participant) is exactly the endpoint from
[Backend token issuance](#backend-token-issuance); this module runs in the browser.

```ts
import { HellaveClient, type Conference, type MediaPublication } from "@hellave/js-sdk";

const roomId = new URLSearchParams(location.search).get("room") ?? "room-123";
const sessionId = crypto.randomUUID(); // one session for the whole conference

const client = new HellaveClient({
  controlUrl: "https://hellave-api.maiaddy.com",
  tokenProvider: async ({ roomId, reason, signal }) => {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/token`, {
      method: "POST",
      credentials: "include",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomInstanceId: "018f47a0-7b2c-7d4e-8d11-111111111111",
        sessionId,
        // Only the first attach may request the lobby.
        lobby: reason === "attach",
      }),
    });
    if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
    return res.json();
  },
});

const tiles = new Map<string, HTMLVideoElement>();
let selfView: HTMLVideoElement | null = null;
let camera: MediaPublication | null = null;

const conference = await client.attach({ roomId, roomInstanceId: "018f47a0-7b2c-7d4e-8d11-111111111111" });
bindConference(conference);

function bindConference(conference: Conference): void {
  conference.on("admitted", async () => {
    // Camera publish only after admission.
    camera = await conference.publishCamera({ width: 1280, height: 720 });
    // Preview a local self-view without publishing it.
    const [capture] = await conference.mediaDeviceController.capturePreview({ audio: false, video: true });
    selfView = document.createElement("video");
    selfView.autoplay = true;
    selfView.muted = true;
    selfView.srcObject = new MediaStream([capture.mediaStreamTrack]);
    document.body.append(selfView);
  });

  conference.on("remoteVideoTrack", (remote) => {
    const video = document.createElement("video");
    video.autoplay = true;
    video.srcObject = new MediaStream([remote.mediaStreamTrack]);
    tiles.set(remote.publicationId, video);
    document.body.append(video);
    // The Public Edge sends no stop message; clear only on ended. A mute is a
    // transient forwarding pause and that track comes back.
    remote.mediaStreamTrack.addEventListener("ended", () => {
      video.remove();
      tiles.delete(remote.publicationId);
    });
  });

  conference.on("roomMessage", ({ fromParticipantId, body }) => {
    const line = document.createElement("div");
    line.textContent = `${fromParticipantId}: ${body}`;
    document.querySelector<HTMLDivElement>("#chat")!.append(line);
  });

  conference.on("error", (error) => {
    // Terminal: obtain fresh authorization and a fresh token before re-attaching.
    console.error(conference.state, error.code);
  });
}

// Send a chat message.
document.querySelector<HTMLButtonElement>("#send")!.addEventListener("click", () => {
  const input = document.querySelector<HTMLInputElement>("#message")!;
  if (input.value) {
    conference.sendMessage(input.value);
    input.value = "";
  }
});

// Leave on unload: commit acknowledged membership leave.
window.addEventListener("beforeunload", () => {
  void conference.leave();
});

```

The `beforeunload` handler is best-effort; on navigation Hellave's bounded reconnect
grace also cleans up. For a full product, wrap `admitted`/`denied`/`failed`/`left` into a
single UI state machine, reconcile `conference.snapshot.participants` into the roster on
`snapshotChanged`, and reuse one stable `commandId` per mutating retry.

## Server-side authorization groundwork

The stable SDK ships microphone, camera, and screen publication plus chat, reactions,
raised hands, recording, and spotlight. Only prototype media and raw signaling objects
remain internal and are never exported to consumers.

- `host` moderation is enforced by the placed SFU through a private authenticated
  control request; it is not only a signaling notification.
- `participant` publishes and receives by default.
- `viewer` is receive-only unless publishing is explicitly granted.
- The SFU verifies issuer, audience, signature, lifetime, organization, room, peer, and
  per-media publishing claims.
- Internal room and placement identity is scoped by organization, so equal customer room
  IDs cannot collide across tenants.
- SFU participant control calls are bound to the peer that created that media session;
  another participant token from the same room cannot operate it.
- Muting changes the SFU's live audio/video forwarding policy and also constrains later
  session or renegotiation offers. Kicking revokes the current media capability and
  disconnects its SFU participant. Destroying a room revokes and disconnects every live
  SFU participant in that room.
- Room placement is automatic and fenced by the orchestrator generation.

Use a stable application Room ID for the reusable meeting identity, create a unique
Room Instance for each actual meeting lifecycle, and authorize membership in the
application backend before requesting an instance-bound token.

## Real two-browser microphone smoke

Against a deployed Public Edge and SFU, the production smoke installs the current local
SDK build into a browser bundle, launches two real headless Chrome pages with fake
microphones, and requires both pages to receive at least three decoded audio frames. It
also verifies that each remote track carries the other page's stable publication and
Room Participant identities.

Provide two distinct, already-admitted Meeting Tokens with microphone publishing
permission for the same Room Instance:

```bash
HELLAVE_CONTROL_URL=https://hellave-api.maiaddy.com \
HELLAVE_ROOM_ID=team-standup \
HELLAVE_ROOM_INSTANCE_ID=018f47a0-7b2c-7d4e-8d11-111111111111 \
HELLAVE_BROWSER_TOKEN_A='token-for-participant-a' \
HELLAVE_BROWSER_TOKEN_B='token-for-participant-b' \
npm run test:real-microphone
```

Set `HELLAVE_CHROME_PATH` when Chrome is not installed in the standard macOS location.
Set `HELLAVE_BROWSER_TIMEOUT_MS` only when the deployment's declared first-media budget
requires a longer diagnostic window. The command exits non-zero for attachment,
publication, identity-association, or real audio-frame failures.
