/** @type {Worker | null} */
let worker = null;

let nextId = 1;

/** @type {Map<number, { resolve: (value: { buffer: ArrayBuffer, encoder: 'native' | 'wasm' }) => void, reject: (error: Error) => void, signal: AbortSignal | undefined, onAbort: (() => void) | undefined }>} */
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

  return new Promise((resolve, reject) => {
    /** @type {(() => void) | undefined} */
    let onAbort;
    if (signal) {
      onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        if (!requests.has(id)) return;
        requests.delete(id);
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    requests.set(id, { resolve, reject, signal, onAbort });
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
  const failed = worker;
  worker = null;
  failed?.terminate();

  const error = new Error(event.message || 'M4A encode worker failed');
  const pending = [...requests.values()];
  requests.clear();
  for (const request of pending) {
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
