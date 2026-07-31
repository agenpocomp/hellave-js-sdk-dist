export class EventEmitter {
    listeners = new Map();
    onceListeners = new Map();
    on(event, listener) {
        this.getOrCreate(event).add(listener);
    }
    once(event, listener) {
        this.getOrCreateOnce(event).add(listener);
    }
    off(event, listener) {
        this.listeners.get(event)?.delete(listener);
        this.onceListeners.get(event)?.delete(listener);
    }
    emit(event, ...args) {
        const group = this.listeners.get(event);
        if (group) {
            for (const listener of group) {
                try {
                    listener(...args);
                }
                catch (error) {
                    console.error(`EventEmitter error on "${String(event)}":`, error);
                }
            }
        }
        const onceGroup = this.onceListeners.get(event);
        if (onceGroup) {
            for (const listener of onceGroup) {
                try {
                    listener(...args);
                }
                catch (error) {
                    console.error(`EventEmitter error on "${String(event)}":`, error);
                }
            }
            this.onceListeners.delete(event);
        }
    }
    removeAllListeners(event) {
        if (event) {
            this.listeners.delete(event);
            this.onceListeners.delete(event);
        }
        else {
            this.listeners.clear();
            this.onceListeners.clear();
        }
    }
    listenerCount(event) {
        const a = this.listeners.get(event)?.size ?? 0;
        const b = this.onceListeners.get(event)?.size ?? 0;
        return a + b;
    }
    getOrCreate(event) {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        return set;
    }
    getOrCreateOnce(event) {
        let set = this.onceListeners.get(event);
        if (!set) {
            set = new Set();
            this.onceListeners.set(event, set);
        }
        return set;
    }
}
//# sourceMappingURL=EventEmitter.js.map