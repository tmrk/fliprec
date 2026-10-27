let shared = null;
let silentUnlockPlayed = false;
const interruptListeners = new Set();

function audioContextConstructor() {
  if (typeof globalThis.AudioContext === 'function') return globalThis.AudioContext;
  if (typeof globalThis.webkitAudioContext === 'function') return globalThis.webkitAudioContext;
  return null;
}

function notifyInterrupted() {
  for (const listener of interruptListeners) {
    try {
      listener('interrupted');
    } catch (error) {
      console.warn(error);
    }
  }
}

function watchInterruptions(ctx) {
  const handle = () => {
    if (ctx.state === 'interrupted') notifyInterrupted();
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

/** One shared context. Created on first use, not at import. */
export function getContext() {
  if (shared) return shared;
  const Ctor = audioContextConstructor();
  if (!Ctor) {
    throw new Error('AudioContext is not available');
  }
  try {
    shared = new Ctor({ latencyHint: 'interactive' });
  } catch (error) {
    // Older webkit builds reject the options dictionary.
    try {
      shared = new Ctor();
    } catch (fallbackError) {
      console.warn(fallbackError);
      throw error;
    }
  }
  watchInterruptions(shared);
  return shared;
}

/**
 * Call synchronously inside a user gesture. `resume()` is not awaited;
 * iOS only honours it on the gesture stack. The 1-sample buffer runs once.
 */
export function unlock() {
  const ctx = getContext();
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
  if (silentUnlockPlayed) return ctx;
  try {
    const sampleRate = ctx.sampleRate || 44100;
    const buffer = ctx.createBuffer(1, 1, sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    silentUnlockPlayed = true;
  } catch (error) {
    console.warn(error);
  }
  return ctx;
}

/** iOS: `play-and-record` while capturing, `playback` otherwise. No-op when absent. */
export function setAudioSessionType(type) {
  try {
    const session = globalThis.navigator?.audioSession;
    if (!session) return;
    session.type = type;
  } catch (error) {
    console.warn(error);
  }
}

/** Fires when the shared context enters `interrupted`. Returns an unsubscribe. */
export function onContextInterrupted(cb) {
  interruptListeners.add(cb);
  return () => {
    interruptListeners.delete(cb);
  };
}
