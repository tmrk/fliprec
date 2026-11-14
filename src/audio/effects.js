import { timeoutError, visibleTimeout } from '../lib/deadline.js';

/** @type {Worker | null} */
let worker = null;
let workerUnavailable = false;
let nextId = 1;

// A 2-minute take renders in well under a second on a desktop; this only catches a wedged worker.
const RENDER_BASE_MS = 15000;
const RENDER_MS_PER_AUDIO_SECOND = 250;

/** @type {Map<number, { resolve: (channels: Float32Array[]) => void, reject: (error: Error) => void, signal: AbortSignal | undefined, onAbort: (() => void) | undefined, stopWatchdog: () => void }>} */
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
  const frames = channels[0]?.length || 0;
  const budget = RENDER_BASE_MS + (sampleRate > 0 ? frames / sampleRate : 0) * RENDER_MS_PER_AUDIO_SECOND;

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
      const request = requests.get(id);
      if (request) {
        request.stopWatchdog = visibleTimeout(
          () => failAll(timeoutError('Effect render timed out')),
          budget,
        );
      }
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
  worker.addEventListener('messageerror', onWorkerError);
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
  pending.stopWatchdog();
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort);
  }
  if (error instanceof Error) pending.reject(error);
  else if (ok && Array.isArray(channels)) pending.resolve(channels);
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
  failAll(new Error(event?.message || 'Effect worker failed'));
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
  for (const id of [...requests.keys()]) settle(id, false, undefined, error);
}

/** @param {AbortSignal} signal */
function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
