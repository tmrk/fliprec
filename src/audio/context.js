let shared = null;
// Set while the page has been hidden, or the context left `running`, since it was last checked.
let stale = false;
// Set when playback saw the clock stand still although the context said `running`.
let stalled = false;
// Audio clock and wall clock when the page last became visible, to spot a frozen clock.
let visibleMark = null;
const unlocked = new WeakSet();
const interruptListeners = new Set();

// A clock that advanced less than this share of wall time after a return is frozen.
const FROZEN_RATIO = 0.25;
const MIN_PROBE_SECONDS = 0.25;

function audioContextConstructor() {
  if (typeof globalThis.AudioContext === 'function') return globalThis.AudioContext;
  if (typeof globalThis.webkitAudioContext === 'function') return globalThis.webkitAudioContext;
  return null;
}

function notify(reason) {
  for (const listener of [...interruptListeners]) {
    try {
      listener(reason);
    } catch (error) {
      console.warn(error);
    }
  }
}

function watchState(ctx) {
  const handle = () => {
    if (ctx !== shared || ctx.state === 'running') return;
    // WebKit reports `interrupted` (calls, Siri, background) or `suspended`; neither resumes
    // reliably in a standalone web app, so the next gesture gets a fresh context.
    stale = true;
    notify(ctx.state);
  };
  if (typeof ctx.addEventListener === 'function') {
    ctx.addEventListener('statechange', handle);
    return;
  }
  const previous = ctx.onstatechange;
  ctx.onstatechange = () => {
    if (typeof previous === 'function') {
      try {
        previous.call(ctx);
      } catch (error) {
        console.warn(error);
      }
    }
    handle();
  };
}

function readClock(ctx) {
  const value = ctx && ctx.currentTime;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function onPageHidden() {
  if (shared) stale = true;
  visibleMark = null;
}

function onPageVisible() {
  visibleMark = shared ? { audio: readClock(shared), wall: performance.now() } : null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onPageHidden();
    else onPageVisible();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', onPageHidden);
  window.addEventListener('pageshow', (event) => {
    if (event && event.persisted) {
      onPageHidden();
      onPageVisible();
    }
  });
}

/** One shared context. Created on first use, not at import. */
export function getContext() {
  if (shared) return shared;
  const Ctor = audioContextConstructor();
  if (!Ctor) {
    throw new Error('AudioContext is not available');
  }
  let created;
  try {
    created = new Ctor({ latencyHint: 'interactive' });
  } catch (error) {
    // Older webkit builds reject the options dictionary.
    try {
      created = new Ctor();
    } catch (fallbackError) {
      console.warn(fallbackError);
      throw error;
    }
  }
  shared = created;
  stale = false;
  stalled = false;
  visibleMark = null;
  watchState(created);
  return created;
}

function clockFrozen(ctx) {
  if (!visibleMark) return false;
  const wall = (performance.now() - visibleMark.wall) / 1000;
  if (wall < MIN_PROBE_SECONDS) return false;
  return readClock(ctx) - visibleMark.audio < wall * FROZEN_RATIO;
}

function needsFreshContext(ctx) {
  if (ctx.state === 'closed' || ctx.state === 'interrupted' || stalled) return true;
  if (!stale) return false;
  return ctx.state !== 'running' || clockFrozen(ctx);
}

/**
 * Swap the shared context for a new one. Listeners hear `replaced` while the old context is
 * still readable, so playback can note its position before the old clock is closed.
 * AudioBuffers are not tied to a context, so decoded takes keep working.
 */
function replaceContext() {
  const old = shared;
  notify('replaced');
  shared = null;
  try {
    const closing = old && old.state !== 'closed' && typeof old.close === 'function' ? old.close() : null;
    if (closing && typeof closing.catch === 'function') closing.catch(() => {});
  } catch {
    /* already closed */
  }
  return getContext();
}

/**
 * Call synchronously inside a user gesture. `resume()` is not awaited;
 * iOS only honours it on the gesture stack. A context that went stale in the
 * background is replaced here, where a new one is allowed to start.
 */
export function unlock() {
  let ctx = getContext();
  if (needsFreshContext(ctx)) {
    try {
      ctx = replaceContext();
    } catch (error) {
      console.warn(error);
      ctx = getContext();
    }
  }
  stale = false;
  visibleMark = null;
  if (typeof ctx.resume === 'function') {
    try {
      const pending = ctx.resume();
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => console.warn(error));
      }
    } catch (error) {
      console.warn(error);
    }
  }
  if (unlocked.has(ctx)) return ctx;
  try {
    const sampleRate = ctx.sampleRate || 44100;
    const buffer = ctx.createBuffer(1, 1, sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    unlocked.add(ctx);
  } catch (error) {
    console.warn(error);
  }
  return ctx;
}

/** Playback saw the clock stand still. The next gesture builds a new context. */
export function markContextStalled() {
  if (shared) stalled = true;
}

/** iOS: `play-and-record` while capturing, `playback` otherwise. No-op when absent. */
export function setAudioSessionType(type) {
  try {
    const session = globalThis.navigator?.audioSession;
    if (!session || session.type === type) return;
    session.type = type;
  } catch (error) {
    console.warn(error);
  }
}

/**
 * Fires with `interrupted`, `suspended` or `closed` when the shared context stops running on its
 * own, and with `replaced` just before a stale context is swapped out. Returns an unsubscribe.
 */
export function onContextInterrupted(cb) {
  interruptListeners.add(cb);
  return () => {
    interruptListeners.delete(cb);
  };
}
