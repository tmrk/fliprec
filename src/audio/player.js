const FADE_SECONDS = 0.006;
const STOP_DELAY = 0.01;
// After a return from the background WebKit can report `running` with a clock that never moves:
// silence, and a source that never ends. A start that has not advanced the clock by this much
// within the check window counts as stalled.
const STALL_CHECK_MS = 1000;
const STALL_MIN_ADVANCE = 0.05;

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * One-shot buffer playback. A new play ramps the previous gain to 0 over 6 ms,
 * then stops that source. Stale `onended` handlers are ignored via a token.
 * Each source keeps the context it started on, so position stays right when the
 * shared context is replaced. `onStall` fires after a stalled start was paused.
 */
export function createPlayer(getContext, { onStall } = {}) {
  let forward = null;
  let reverse = null;
  let state = 'stopped';
  let direction = 'forward';
  let anchorOffset = 0;
  let startedAt = 0;
  let active = null;
  let activeToken = 0;
  let disposed = false;
  const listeners = new Set();

  function bufferFor(dir) {
    return dir === 'reverse' ? reverse : forward;
  }

  function durationOf(dir = direction) {
    const buffer = bufferFor(dir);
    if (!buffer || !(buffer.sampleRate > 0)) return 0;
    if (typeof buffer.duration === 'number' && Number.isFinite(buffer.duration)) return buffer.duration;
    return buffer.length / buffer.sampleRate;
  }

  function emit() {
    const snapshot = { state, direction };
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn(error);
      }
    }
  }

  function disconnect(node) {
    if (!node || typeof node.disconnect !== 'function') return;
    try {
      node.disconnect();
    } catch (error) {
      console.warn(error);
    }
  }

  function resumeIfNeeded(ctx) {
    if (ctx.state !== 'suspended' && ctx.state !== 'interrupted') return;
    if (typeof ctx.resume !== 'function') return;
    try {
      const pending = ctx.resume();
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => console.warn(error));
      }
    } catch (error) {
      console.warn(error);
    }
  }

  /** Invalidate `entry` before stop(), which may fire onended synchronously. */
  function retire(entry) {
    activeToken += 1;
    if (entry.stallTimer) clearTimeout(entry.stallTimer);
    entry.stallTimer = 0;
    const ctx = entry.ctx;
    const now = ctx.currentTime;
    try {
      const param = entry.gain.gain;
      if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
      const current = typeof param.value === 'number' && Number.isFinite(param.value) ? param.value : 1;
      param.setValueAtTime(current, now);
      param.linearRampToValueAtTime(0, now + FADE_SECONDS);
      entry.source.stop(now + STOP_DELAY);
    } catch (error) {
      console.warn(error);
    }
    if (active === entry) active = null;
  }

  function watchForStall(entry) {
    if (typeof onStall !== 'function') return;
    const wallStart = performance.now();
    const audioStart = entry.ctx.currentTime;
    entry.stallTimer = setTimeout(() => {
      entry.stallTimer = 0;
      if (disposed || active !== entry || state !== 'playing') return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (performance.now() - wallStart < STALL_CHECK_MS / 2) return;
      if (entry.ctx.currentTime - audioStart >= STALL_MIN_ADVANCE) return;
      pause();
      try {
        onStall();
      } catch (error) {
        console.warn(error);
      }
    }, STALL_CHECK_MS);
  }

  function arm(source, gain, token) {
    source.onended = () => {
      disconnect(source);
      disconnect(gain);
      if (token !== activeToken) return;
      activeToken += 1;
      active = null;
      state = 'stopped';
      anchorOffset = 0;
      startedAt = 0;
      emit();
    };
  }

  function play(nextDirection, offsetSeconds = 0) {
    if (disposed) return;
    const dir = nextDirection === 'reverse' ? 'reverse' : 'forward';
    const buffer = bufferFor(dir);
    if (!buffer) return;

    const ctx = getContext();
    resumeIfNeeded(ctx);
    if (active) retire(active);

    direction = dir;
    const duration = durationOf(dir);
    const offset = clamp(Number.isFinite(offsetSeconds) ? offsetSeconds : 0, 0, duration);
    if (!(duration > offset)) {
      state = 'stopped';
      anchorOffset = 0;
      startedAt = 0;
      emit();
      return;
    }

    const token = ++activeToken;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE_SECONDS);
    arm(source, gain, token);
    source.start(now, offset);

    active = { source, gain, token, ctx, stallTimer: 0 };
    anchorOffset = offset;
    startedAt = now;
    state = 'playing';
    watchForStall(active);
    emit();
  }

  function pause() {
    if (state !== 'playing' || !active) return;
    const position = clamp(anchorOffset + (active.ctx.currentTime - startedAt), 0, durationOf());
    retire(active);
    anchorOffset = position;
    startedAt = 0;
    state = 'paused';
    emit();
  }

  function resume() {
    if (state !== 'paused') return;
    play(direction, anchorOffset);
  }

  function seek(seconds) {
    if (disposed) return;
    if (state === 'playing') {
      play(direction, seconds);
      return;
    }
    anchorOffset = clamp(Number.isFinite(seconds) ? seconds : 0, 0, durationOf());
    if (state === 'stopped') state = 'paused';
    emit();
  }

  function stop() {
    if (active) {
      try {
        retire(active);
      } catch (error) {
        console.warn(error);
        active = null;
      }
    }
    const changed = state !== 'stopped' || anchorOffset !== 0;
    state = 'stopped';
    anchorOffset = 0;
    startedAt = 0;
    if (changed) emit();
  }

  function load(nextForward, nextReverse) {
    stop();
    forward = nextForward || null;
    reverse = nextReverse || null;
  }

  /**
   * Swap in new buffers (same take, new speed or pitch) while keeping the transport:
   * state, direction and the relative position all carry over.
   */
  function replace(nextForward, nextReverse) {
    if (disposed) return;
    if (!nextForward && !nextReverse) {
      unload();
      return;
    }
    const oldDuration = durationOf(direction);
    const fraction = oldDuration > 0 ? clamp(getPosition() / oldDuration, 0, 1) : 0;
    forward = nextForward || null;
    reverse = nextReverse || null;
    const offset = fraction * durationOf(direction);
    if (state === 'playing') {
      play(direction, offset);
      return;
    }
    if (state === 'paused') anchorOffset = clamp(offset, 0, durationOf(direction));
  }

  function unload() {
    stop();
    forward = null;
    reverse = null;
  }

  function getPosition() {
    if (state === 'stopped') return 0;
    if (state === 'paused') return anchorOffset;
    const clock = active ? active.ctx : getContext();
    const position = anchorOffset + (clock.currentTime - startedAt);
    return clamp(position, 0, durationOf());
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    forward = null;
    reverse = null;
    listeners.clear();
  }

  return {
    load,
    replace,
    unload,
    play,
    pause,
    resume,
    seek,
    stop,
    getPosition,
    getDuration() {
      return durationOf();
    },
    getState() {
      return { state, direction };
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose,
  };
}
