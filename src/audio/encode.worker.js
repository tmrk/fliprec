import { encodeM4a } from './encodeM4a.js';

/** Sequential so one encode finishes before the next starts. */
let tail = Promise.resolve();

self.onmessage = (event) => {
  const message = event.data;
  tail = tail.then(() => handle(message)).catch(() => {});
};

/**
 * @param {{ id?: number, channels?: Float32Array[], sampleRate?: number, bitrate?: number, forceFallback?: boolean }} message
 */
async function handle(message) {
  const id = message?.id;
  try {
    const channels = message.channels;
    const sampleRate = message.sampleRate;
    const bitrate = message.bitrate ?? 128000;
    const forceFallback = message.forceFallback === true;
    const { buffer, encoder } = await encodeM4a({
      channels,
      sampleRate,
      bitrate,
      forceFallback,
    });
    self.postMessage({ id, ok: true, buffer, encoder }, [buffer]);
  } catch (error) {
    if (id === undefined) return;
    const text = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, ok: false, error: text });
  }
}
