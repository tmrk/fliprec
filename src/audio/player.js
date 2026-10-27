const FADE_SECONDS = 0.006;
const STOP_DELAY = 0.01;

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * One-shot buffer playback. A new play ramps the previous gain to 0 over 6 ms,
 * then stops that source. Stale `onended` handlers are ignored via a token.
 */
export function createPlayer(getContext) {
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
  function retire(ctx, entry) {
    activeToken += 1;
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
    if (active) retire(ctx, active);

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

    active = { source, gain, token };
    anchorOffset = offset;
    startedAt = now;
    state = 'playing';
    emit();
  }

  function pause() {
    if (state !== 'playing' || !active) return;
    const ctx = getContext();
    const position = clamp(anchorOffset + (ctx.currentTime - startedAt), 0, durationOf());
    retire(ctx, active);
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
        retire(getContext(), active);
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

  function unload() {
    stop();
    forward = null;
    reverse = null;
  }

  function getPosition() {
    if (state === 'stopped') return 0;
    if (state === 'paused') return anchorOffset;
    const position = anchorOffset + (getContext().currentTime - startedAt);
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
