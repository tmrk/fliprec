import { afterEach, describe, expect, it, vi } from 'vitest';

const originalAudioContext = globalThis.AudioContext;
const originalWebkit = globalThis.webkitAudioContext;
const originalAudioSession = globalThis.navigator?.audioSession;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAudioContext === undefined) delete globalThis.AudioContext;
  else globalThis.AudioContext = originalAudioContext;
  if (originalWebkit === undefined) delete globalThis.webkitAudioContext;
  else globalThis.webkitAudioContext = originalWebkit;
  if (originalAudioSession === undefined) delete globalThis.navigator.audioSession;
  else globalThis.navigator.audioSession = originalAudioSession;
});

async function loadContext() {
  vi.resetModules();
  return import('../../src/audio/context.js');
}

function installContext({ webkit = false, rejectOptions = false, events = true, resume } = {}) {
  const created = [];
  class FakeAudioContext {
    constructor(options) {
      if (rejectOptions && options) throw new Error('options not supported');
      this.options = options;
      this.sampleRate = 48000;
      this.state = 'suspended';
      this.destination = { id: 'destination' };
      this.sources = [];
      this.resume = vi.fn(() => {
        this.state = 'running';
        return resume ? resume(this) : Promise.resolve();
      });
      this.listeners = [];
      created.push(this);
    }

    addEventListener(type, fn) {
      if (!events) return;
      if (type === 'statechange') this.listeners.push(fn);
    }

    createBuffer(channels, length, sampleRate) {
      return { numberOfChannels: channels, length, sampleRate };
    }

    createBufferSource() {
      const source = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        disconnect: vi.fn(),
      };
      this.sources.push(source);
      return source;
    }

    emitState() {
      if (events) {
        for (const listener of this.listeners) listener();
      } else if (typeof this.onstatechange === 'function') {
        this.onstatechange();
      }
    }
  }

  if (!events) {
    FakeAudioContext.prototype.addEventListener = undefined;
  }

  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  if (webkit) globalThis.webkitAudioContext = FakeAudioContext;
  else globalThis.AudioContext = FakeAudioContext;
  return { created, FakeAudioContext };
}

describe('getContext', () => {
  it('creates one interactive context and reuses it', async () => {
    const { created } = installContext();
    const { getContext } = await loadContext();
    const first = getContext();
    const second = getContext();
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(first.options).toEqual({ latencyHint: 'interactive' });
  });

  it('falls back to webkitAudioContext', async () => {
    const { FakeAudioContext } = installContext({ webkit: true });
    const { getContext } = await loadContext();
    const ctx = getContext();
    expect(ctx).toBeInstanceOf(FakeAudioContext);
    expect(ctx.options).toEqual({ latencyHint: 'interactive' });
  });

  it('constructs without options when the dictionary is rejected', async () => {
    installContext({ rejectOptions: true });
    const { getContext } = await loadContext();
    const ctx = getContext();
    expect(ctx.options).toBeUndefined();
    expect(ctx.sampleRate).toBe(48000);
  });

  it('throws when no audio context constructor exists', async () => {
    delete globalThis.AudioContext;
    delete globalThis.webkitAudioContext;
    const { getContext } = await loadContext();
    expect(() => getContext()).toThrow(/AudioContext/);
  });
});

describe('unlock', () => {
  it('resumes and starts one silent sample without waiting on resume()', async () => {
    let settled = false;
    let resolveResume = () => {};
    installContext({
      resume: () => new Promise((resolve) => {
        resolveResume = () => {
          settled = true;
          resolve();
        };
      }),
    });
    const { unlock } = await loadContext();

    const ctx = unlock();
    expect(settled).toBe(false);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].buffer.length).toBe(1);
    expect(ctx.sources[0].buffer.numberOfChannels).toBe(1);
    expect(ctx.sources[0].buffer.sampleRate).toBe(48000);
    expect(ctx.sources[0].connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.sources[0].start).toHaveBeenCalledWith(0);

    unlock();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(ctx.sources).toHaveLength(1);

    resolveResume();
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});

describe('setAudioSessionType', () => {
  it('sets navigator.audioSession.type when the API exists', async () => {
    installContext();
    const { setAudioSessionType } = await loadContext();
    const session = { type: 'auto' };
    globalThis.navigator.audioSession = session;
    setAudioSessionType('play-and-record');
    expect(session.type).toBe('play-and-record');
    setAudioSessionType('playback');
    expect(session.type).toBe('playback');
  });

  it('does nothing when audioSession is missing or throws', async () => {
    installContext();
    const { setAudioSessionType } = await loadContext();
    delete globalThis.navigator.audioSession;
    expect(() => setAudioSessionType('playback')).not.toThrow();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(globalThis.navigator, 'audioSession', {
      configurable: true,
      get() {
        throw new Error('audioSession blocked');
      },
    });
    expect(() => setAudioSessionType('play-and-record')).not.toThrow();
    expect(warn).toHaveBeenCalled();
    delete globalThis.navigator.audioSession;
  });
});

describe('onContextInterrupted', () => {
  it('notifies on interrupted and ignores other states', async () => {
    const { created } = installContext();
    const { getContext, onContextInterrupted } = await loadContext();
    const ctx = getContext();
    const seen = [];
    const unsubscribe = onContextInterrupted((state) => seen.push(state));

    ctx.state = 'running';
    ctx.emitState();
    ctx.state = 'suspended';
    ctx.emitState();
    expect(seen).toEqual([]);

    ctx.state = 'interrupted';
    ctx.emitState();
    expect(seen).toEqual(['interrupted']);

    unsubscribe();
    ctx.emitState();
    expect(seen).toEqual(['interrupted']);
    expect(created).toHaveLength(1);
  });

  it('keeps notifying later listeners when one throws', async () => {
    installContext({ events: false });
    const { getContext, onContextInterrupted } = await loadContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = getContext();
    const seen = [];
    onContextInterrupted(() => {
      throw new Error('listener failed');
    });
    onContextInterrupted(() => seen.push('ok'));

    ctx.state = 'interrupted';
    ctx.onstatechange();
    expect(seen).toEqual(['ok']);
    expect(warn).toHaveBeenCalled();
  });
});
