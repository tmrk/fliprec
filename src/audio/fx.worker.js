import { renderEffect } from './fx.js';

/** Sequential so a newer render never races an older one. */
let tail = Promise.resolve();
const cancelled = new Set();

self.onmessage = (event) => {
  const message = event.data;
  if (message && message.cancel !== undefined) {
    cancelled.add(message.cancel);
    return;
  }
  tail = tail.then(() => handle(message)).catch(() => {});
};

/**
 * @param {{ id?: number, channels?: Float32Array[], sampleRate?: number, effect?: { speed: number, pitch: number } }} message
 */
function handle(message) {
  const id = message?.id;
  if (cancelled.delete(id)) {
    self.postMessage({ id, ok: false, error: 'cancelled' });
    return;
  }
  try {
    const input = message.channels;
    const output = renderEffect(input, message.sampleRate, message.effect);
    // A neutral effect returns the input arrays; transfer them back as they are.
    self.postMessage({ id, ok: true, channels: output }, output.map((channel) => channel.buffer));
  } catch (error) {
    if (id === undefined) return;
    const text = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, ok: false, error: text });
  }
}
