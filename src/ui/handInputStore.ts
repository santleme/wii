import { useSyncExternalStore } from 'react';
import { HAND_IDLE, type HandCursorInput } from './handCursorTypes';

/**
 * Latest hand sample, published at camera rate outside React state. Per-frame consumers read
 * `current` from their own rAF loop; components subscribe to the discrete values they render.
 */
export interface HandInputStore {
  readonly current: HandCursorInput;
  /** Last sample with a visible hand: what the cursor keeps showing while it fades out. */
  readonly lastVisible: HandCursorInput;
  /** Confirmed clicks so far; each new one restarts the confirmation flash. */
  readonly clicks: number;
  publish(next: HandCursorInput): void;
  subscribe(listener: () => void): () => void;
}

export function createHandInputStore(initial: HandCursorInput = HAND_IDLE): HandInputStore {
  const listeners = new Set<() => void>();
  let current = initial;
  let lastVisible = initial;
  let clicks = initial.pinchRelease ? 1 : 0;
  return {
    get current() {
      return current;
    },
    get lastVisible() {
      return lastVisible;
    },
    get clicks() {
      return clicks;
    },
    publish(next) {
      if (next.pinchRelease && !current.pinchRelease) clicks += 1;
      current = next;
      if (next.visible) lastVisible = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Re-renders only when the selected primitive changes. */
export function useHandInput<T extends string | number | boolean>(
  store: HandInputStore,
  select: (store: HandInputStore) => T,
): T {
  return useSyncExternalStore(store.subscribe, () => select(store));
}
