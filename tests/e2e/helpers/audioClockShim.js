/**
 * Automation hosts often leave AudioContext.currentTime stuck at ~0, so
 * playback position never moves and AudioBufferSourceNode never ends.
 * Installed only by record-playback.spec.js. When a short probe shows the
 * real clock is frozen, currentTime follows performance.now() from resume
 * and start/stop synthesize ended after the remaining buffer time.
 */
(() => {
  if (window.__fliprecAudioClockInstalled) return;
  window.__fliprecAudioClockInstalled = true;

  const Base = window.BaseAudioContext;
  const Source = window.AudioBufferSourceNode;
  const Ctx = window.AudioContext;
  if (!Base || !Source || !Ctx) return;

  const realDescriptor = Object.getOwnPropertyDescriptor(Base.prototype, 'currentTime');
  const realGet = realDescriptor && realDescriptor.get;
  if (typeof realGet !== 'function') return;

  const clocks = new WeakMap();
  const pendingEnded = new WeakMap();
  let prototypePatched = false;

  function isOffline(ctx) {
    return typeof OfflineAudioContext === 'function' && ctx instanceof OfflineAudioContext;
  }

  function ensure(ctx) {
    let clock = clocks.get(ctx);
    if (!clock) {
      clock = {
        running: false,
        originAudio: 0,
        originWall: 0,
        frozen: false,
        decided: false,
        probeStarted: false,
      };
      clocks.set(ctx, clock);
      ctx.addEventListener('statechange', () => syncRunning(ctx, clock));
    }
    syncRunning(ctx, clock);
    if (!prototypePatched) shadowCurrentTime(ctx);
    return clock;
  }

  function syncRunning(ctx, clock) {
    const running = ctx.state === 'running';
    if (running && !clock.running) {
      clock.running = true;
      clock.originAudio = realGet.call(ctx);
      clock.originWall = performance.now();
      armProbe(ctx, clock);
      return;
    }
    if (!running && clock.running) {
      if (clock.frozen) {
        clock.originAudio += (performance.now() - clock.originWall) / 1000;
      }
      clock.originWall = performance.now();
      clock.running = false;
    }
  }

  function armProbe(ctx, clock) {
    if (clock.probeStarted) return;
    clock.probeStarted = true;
    const startReal = realGet.call(ctx);
    const startWall = performance.now();
    setTimeout(() => {
      if (clock.decided) return;
      const advanced = realGet.call(ctx) - startReal;
      const elapsed = (performance.now() - startWall) / 1000;
      clock.frozen = elapsed >= 0.12 && advanced < Math.max(0.02, elapsed * 0.25);
      clock.decided = true;
      window.__fliprecAudioClock = { frozen: clock.frozen, advanced, elapsed };
    }, 200);
  }

  function readClock(ctx) {
    if (isOffline(ctx)) return realGet.call(ctx);
    const clock = ensure(ctx);
    if (!clock.frozen) return realGet.call(ctx);
    if (!clock.running) return clock.originAudio;
    return clock.originAudio + (performance.now() - clock.originWall) / 1000;
  }

  function shadowCurrentTime(ctx) {
    if (Object.prototype.hasOwnProperty.call(ctx, 'currentTime')) return;
    Object.defineProperty(ctx, 'currentTime', {
      configurable: true,
      get() {
        return readClock(ctx);
      },
    });
  }

  try {
    Object.defineProperty(Base.prototype, 'currentTime', {
      configurable: true,
      enumerable: realDescriptor.enumerable !== false,
      get() {
        return readClock(this);
      },
    });
    prototypePatched = true;
  } catch {
    prototypePatched = false;
  }

  const nativeResume = Ctx.prototype.resume;
  if (typeof nativeResume === 'function') {
    Ctx.prototype.resume = function resume() {
      const clock = ensure(this);
      const pending = nativeResume.apply(this, arguments);
      syncRunning(this, clock);
      return pending;
    };
  }

  function cancelEnded(node) {
    const timer = pendingEnded.get(node);
    if (timer == null) return;
    clearTimeout(timer);
    pendingEnded.delete(node);
  }

  function fireEnded(node) {
    const event = new Event('ended');
    const previous = node.onended;
    let called = false;
    if (typeof previous === 'function') {
      node.onended = function wrapped(ev) {
        called = true;
        return previous.call(this, ev);
      };
    }
    try {
      node.dispatchEvent(event);
    } finally {
      if (typeof previous === 'function') node.onended = previous;
    }
    if (!called && typeof previous === 'function') previous.call(node, event);
  }

  function scheduleEnded(node, when, offset, duration) {
    const ctx = node.context;
    if (!ctx || isOffline(ctx)) return;
    const clock = clocks.get(ctx);
    if (!clock || !clock.frozen) return;
    const buffer = node.buffer;
    if (!buffer || !(buffer.duration > 0)) return;

    const off = Number.isFinite(offset) ? Math.max(0, offset) : 0;
    let remaining = Math.max(0, buffer.duration - off);
    if (Number.isFinite(duration)) remaining = Math.min(remaining, Math.max(0, duration));
    if (!(remaining > 0)) return;

    const now = ctx.currentTime;
    const startWhen = Number.isFinite(when) ? when : now;
    const delay = Math.max(0, startWhen - now);
    cancelEnded(node);
    const timer = setTimeout(() => {
      if (pendingEnded.get(node) !== timer) return;
      pendingEnded.delete(node);
      fireEnded(node);
    }, (delay + remaining) * 1000);
    pendingEnded.set(node, timer);
  }

  const nativeStart = Source.prototype.start;
  Source.prototype.start = function start(when, offset, duration) {
    const result = nativeStart.apply(this, arguments);
    scheduleEnded(this, when, offset, duration);
    return result;
  };

  const nativeStop = Source.prototype.stop;
  Source.prototype.stop = function stop() {
    cancelEnded(this);
    return nativeStop.apply(this, arguments);
  };
})();
