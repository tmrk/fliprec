import { timeoutError, visibleTimeout } from '../lib/deadline.js';

/** @type {Worker | null} */
let worker = null;

// Generous: the WASM fallback on an older phone still runs well above real time.
const ENCODE_BASE_MS = 20000;
const ENCODE_MS_PER_AUDIO_SECOND = 1000;

let nextId = 1;

/** @type {Map<number, { resolve: (value: { buffer: ArrayBuffer, encoder: 'native' | 'wasm' }) => void, reject: (error: Error) => void, signal: AbortSignal | undefined, onAbort: (() => void) | undefined, stopWatchdog: () => void }>} */
const requests = new Map();

/**
 * Encode PCM to AAC-LC M4A on a single lazily created module worker.
 * Callers pass channel copies; their buffers are transferred.
 * `?aac=wasm` forces the WASM encoder.
 * @param {{ channels: Float32Array[], sampleRate: number, signal?: AbortSignal }} options
 * @returns {Promise<{ buffer: ArrayBuffer, encoder: 'native' | 'wasm' }>}
 */
export function encodeM4A({ channels, sampleRate, signal }) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  const id = nextId;
  nextId += 1;
  const active = getWorker();
  const frames = channels[0]?.length || 0;
  const seconds = sampleRate > 0 ? frames / sampleRate : 0;
  const budget = ENCODE_BASE_MS + seconds * ENCODE_MS_PER_AUDIO_SECOND;

  return new Promise((resolve, reject) => {
    /** @type {(() => void) | undefined} */
    let onAbort;
    if (signal) {
      onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        const request = requests.get(id);
        if (!request) return;
        requests.delete(id);
        request.stopWatchdog();
        try {
          worker?.postMessage({ cancel: id });
        } catch {
          /* worker already gone */
        }
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    requests.set(id, { resolve, reject, signal, onAbort, stopWatchdog: () => {} });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      const forceFallback = new URLSearchParams(location.search).get('aac') === 'wasm';
      const transfers = channels.map((channel) => channel.buffer);
      active.postMessage(
        { id, channels, sampleRate, forceFallback },
        transfers,
      );
      const request = requests.get(id);
      if (request) {
        request.stopWatchdog = visibleTimeout(
          () => failAll(timeoutError('M4A encoding timed out')),
          budget,
        );
      }
    } catch (error) {
      requests.delete(id);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} filename
 */
export function m4aFile(buffer, filename) {
  return new File([buffer], filename, {
    type: 'audio/mp4',
    lastModified: Date.now(),
  });
}

function getWorker() {
  if (worker) return worker;

  worker = new Worker(new URL('./encode.worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onWorkerError);
  worker.addEventListener('messageerror', onWorkerError);
  return worker;
}

/**
 * @param {MessageEvent} event
 */
function onMessage(event) {
  const { id, ok, buffer, encoder, error } = event.data ?? {};
  const pending = requests.get(id);
  if (!pending) return;

  requests.delete(id);
  pending.stopWatchdog();
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort);
  }

  if (ok) pending.resolve({ buffer, encoder });
  else pending.reject(new Error(error || 'M4A encoding failed'));
}

/**
 * A worker crash rejects every in-flight request. The next encode creates a new worker.
 * @param {ErrorEvent} event
 */
function onWorkerError(event) {
  failAll(new Error(event?.message || 'M4A encode worker failed'));
}

/**
 * Tear the worker down (it crashed or stopped answering) and reject everything in flight.
 * @param {Error} error
 */
function failAll(error) {
  const failed = worker;
  worker = null;
  try {
    failed?.terminate();
  } catch {
    /* already gone */
  }

  const pending = [...requests.values()];
  requests.clear();
  for (const request of pending) {
    request.stopWatchdog();
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener('abort', request.onAbort);
    }
    request.reject(error);
  }
}

/**
 * @param {AbortSignal} signal
 */
function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
