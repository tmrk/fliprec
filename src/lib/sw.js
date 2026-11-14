import { registerSW } from 'virtual:pwa-register';
import { store } from '../engine/store.js';
import { createUpdateGate, watchForUpdates } from './updates.js';

function isIdle() {
  const { phase, playback } = store.getState();
  return (phase === 'empty' || phase === 'ready') && playback.state !== 'playing';
}

/** Registers the service worker. Loaded after first paint, outside the entry chunk. */
export function startServiceWorker() {
  let updateSW = () => {};
  const gate = createUpdateGate({
    applyUpdate: () => updateSW(true),
    isIdle,
    subscribe: store.subscribe,
  });
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => gate.onNeedRefresh(),
    onRegisteredSW: (_url, registration) => {
      if (registration) watchForUpdates(registration);
    },
  });
}
