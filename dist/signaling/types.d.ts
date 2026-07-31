export interface IceCandidatePayload {
    candidate: string;
    sdp_mid?: string;
    sdp_mline_index?: number;
}
export type RoomRole = "host" | "participant" | "viewer";
export interface MutedStatePayload {
    audio: boolean;
    video: boolean;
}
export type ClientSignal = {
    type: "join";
    token: string;
} | {
    type: "offer";
    target_peer_id: string;
    sdp: string;
} | {
    type: "answer";
    target_peer_id: string;
    sdp: string;
} | {
    type: "ice_candidate";
    target_peer_id: string;
    candidate: IceCandidatePayload;
} | {
    type: "admit";
    peer_id: string;
} | {
    type: "deny";
    peer_id: string;
    reason?: string;
} | {
    type: "mute";
    peer_id: string;
    audio: boolean;
    video: boolean;
} | {
    type: "kick";
    peer_id: string;
    reason?: string;
} | {
    type: "destroy_room";
} | {
    type: "ping";
};
export type ServerSignal = {
    type: "joined";
    room_id: string;
    peer_id: string;
    role: RoomRole;
    admitted: boolean;
    peers: string[];
    lobby_peers: string[];
    muted: MutedStatePayload;
    media_token: string;
} | {
    type: "peer_joined";
    peer_id: string;
    role: RoomRole;
} | {
    type: "peer_left";
    peer_id: string;
} | {
    type: "lobby_waiting";
    room_id: string;
    peer_id: string;
} | {
    type: "lobby_updated";
    peers: string[];
} | {
    type: "peer_denied";
    peer_id: string;
    reason?: string;
} | {
    type: "peer_kicked";
    peer_id: string;
    reason?: string;
} | {
    type: "mute_state_changed";
    peer_id: string;
    muted: MutedStatePayload;
} | {
    type: "offer";
    from_peer_id: string;
    sdp: string;
} | {
    type: "answer";
    from_peer_id: string;
    sdp: string;
} | {
    type: "ice_candidate";
    from_peer_id: string;
    candidate: IceCandidatePayload;
} | {
    type: "error";
    message: string;
} | {
    type: "room_destroyed";
    room_id: string;
} | {
    type: "pong";
};
//# sourceMappingURL=types.d.ts.map