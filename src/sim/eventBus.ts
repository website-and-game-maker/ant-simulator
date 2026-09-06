import type { SimEventMap, SimEventName } from './types';

type Listener<K extends SimEventName> = (payload: SimEventMap[K]) => void;

/** Minimal typed pub/sub so the engine, renderer, UI and audio layer can stay
 * decoupled — nobody needs a reference into Simulation internals to react to
 * a birth, death, or colony collapse. */
export class EventBus {
  private listeners = new Map<SimEventName, Set<Listener<any>>>();

  on<K extends SimEventName>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends SimEventName>(event: K, payload: SimEventMap[K]) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}
