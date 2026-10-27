import { useSyncExternalStore } from 'react';
import { store } from '../engine/store.js';

export function useStore(selector) {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
