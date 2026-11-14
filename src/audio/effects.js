/** @type {Worker | null} */
let worker = null;
let workerUnavailable = false;
let nextId = 1;

/** @type {Map<number, { resolve: (channels: Float32Array[]) => void, reject: (error: Error) => void, signal: AbortSignal | undefined, onAbort: (() => void) | undefined }>} */
const requests = new Map();

/**
 * Apply speed and pitch off the main thread. Callers pass channel copies; their buffers are
 * transferred. Where a worker cannot be created the render runs on the main thread instead.
 * @param {{ channels: Float32Array[], sampleRate: number, effect: { speed: number, pitch: number }, signal?: AbortSignal }} options
 * @returns {Promise<Float32Array[]>}
 */
export function renderEffectInWorker({ channels, sampleRate, effect, signal }) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  const id = nextId;
  nextId += 1;

  return new Promise((resolve, reject) => {
    /** @type {(() => void) | undefined} */
    let onAbort;
    if (signal) {
      onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        if (!requests.has(id)) return;
        requests.delete(id);
        try {
          worker?.postMessage({ cancel: id });
        } catch {
          /* worker already gone */
        }
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    requests.set(id, { resolve, reject, signal, onAbort });

    const active = getWorker();
    if (!active) {
      void renderLocally(id, channels, sampleRate, effect);
      return;
    }
    try {
      active.postMessage(
        { id, channels, sampleRate, effect },
        channels.map((channel) => channel.buffer),
      );
    } catch {
      void renderLocally(id, channels, sampleRate, effect);
    }
  });
}

function getWorker() {
  if (worker) return worker;
  if (workerUnavailable || typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./fx.worker.js', import.meta.url), { type: 'module' });
  } catch {
    workerUnavailable = true;
    return null;
  }
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onWorkerError);
  return worker;
}

async function renderLocally(id, channels, sampleRate, effect) {
  try {
    const { renderEffect } = await import('./fx.js');
    if (!requests.has(id)) return;
    const output = renderEffect(channels, sampleRate, effect);
    settle(id, true, output);
  } catch (error) {
    settle(id, false, undefined, error instanceof Error ? error.message : String(error));
  }
}

function settle(id, ok, channels, error) {
  const pending = requests.get(id);
  if (!pending) return;
  requests.delete(id);
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort);
  }
  if (ok && Array.isArray(channels)) pending.resolve(channels);
  else pending.reject(new Error(error || 'Effect render failed'));
}

/** @param {MessageEvent} event */
function onMessage(event) {
  const { id, ok, channels, error } = event.data ?? {};
  settle(id, ok, channels, error);
}

/**
 * A crash rejects every in-flight render (their input was transferred).
 * The next render creates a new worker.
 * @param {ErrorEvent} event
 */
function onWorkerError(event) {
  const failed = worker;
  worker = null;
  failed?.terminate();
  const message = event?.message || 'Effect worker failed';
  for (const id of [...requests.keys()]) settle(id, false, undefined, message);
}

/** @param {AbortSignal} signal */
function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
