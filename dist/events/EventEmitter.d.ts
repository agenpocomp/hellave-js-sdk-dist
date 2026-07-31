type Listener<Args extends unknown[]> = (...args: Args) => void;
export declare class EventEmitter<Events> {
    private listeners;
    private onceListeners;
    on<Event extends keyof Events>(event: Event, listener: Events[Event] extends unknown[] ? Listener<Events[Event]> : never): void;
    once<Event extends keyof Events>(event: Event, listener: Events[Event] extends unknown[] ? Listener<Events[Event]> : never): void;
    off<Event extends keyof Events>(event: Event, listener: Events[Event] extends unknown[] ? Listener<Events[Event]> : never): void;
    emit<Event extends keyof Events>(event: Event, ...args: Events[Event] extends unknown[] ? Events[Event] : never): void;
    removeAllListeners(event?: keyof Events): void;
    listenerCount(event: keyof Events): number;
    private getOrCreate;
    private getOrCreateOnce;
}
export {};
//# sourceMappingURL=EventEmitter.d.ts.map