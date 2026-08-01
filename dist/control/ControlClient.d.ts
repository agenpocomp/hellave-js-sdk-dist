/** A chat message delivered to the room. Transient: never stored or replayed. */
export interface RoomMessage {
    fromParticipantId: string;
    body: string;
    /** Server receive time, as a Unix timestamp in seconds. */
    sentAt: number;
}
/** A transient reaction from one participant. */
export interface ReceivedReaction {
    fromParticipantId: string;
    reaction: string;
    /** Server receive time, as a Unix timestamp in seconds. */
    sentAt: number;
}
//# sourceMappingURL=ControlClient.d.ts.map