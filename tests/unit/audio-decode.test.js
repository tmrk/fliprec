import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeToBuffer,
  downmixToStereo,
  limitBuffer,
  resampleIfNeeded,
  validateRecording,
} from '../../src/audio/decode.js';

const originalOffline = globalThis.OfflineAudioContext;
const originalWebkitOffline = globalThis.webkitOfflineAudioContext;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalOffline === undefined) delete globalThis.OfflineAudioContext;
  else globalThis.OfflineAudioContext = originalOffline;
  if (originalWebkitOffline === undefined) delete globalThis.webkitOfflineAudioContext;
  else globalThis.webkitOfflineAudioContext = originalWebkitOffline;
});

function wrap(channels, sampleRate) {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData(index) {
      return channels[index];
    },
    copyToChannel(source, index, start = 0) {
      channels[index].set(source, start);
    },
  };
}

function makeBuffer(channelData, sampleRate) {
  return wrap(channelData.map((data) => Float32Array.from(data)), sampleRate);
}

function makeContext() {
  return {
    createBuffer(numberOfChannels, length, sampleRate) {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      return wrap(channels, sampleRate);
    },
  };
}

describe('decodeToBuffer', () => {
  it('copies the ArrayBuffer before a promise-based decode', async () => {
    const original = new Uint8Array([1, 2, 3, 4]).buffer;
    let received = null;
    const decoded = makeBuffer([Float32Array.of(0.5)], 48000);
    const ctx = {
      decodeAudioData(buffer) {
        received = buffer;
        new Uint8Array(buffer).fill(0);
        return Promise.resolve(decoded);
      },
    };

    await expect(decodeToBuffer(ctx, original)).resolves.toBe(decoded);
    expect(received).not.toBe(original);
    expect(Array.from(new Uint8Array(original))).toEqual([1, 2, 3, 4]);
    expect(Array.from(new Uint8Array(received))).toEqual([0, 0, 0, 0]);
  });

  it('resolves from the success callback when no promise is returned', async () => {
    const decoded = { marker: 'callback' };
    const ctx = {
      decodeAudioData(_buffer, success) {
        success(decoded);
        return undefined;
      },
    };
    await expect(decodeToBuffer(ctx, new ArrayBuffer(2))).resolves.toBe(decoded);
  });

  it('rejects from the error callback and from a rejected promise', async () => {
    const callbackCtx = {
      decodeAudioData(_buffer, _success, failure) {
        failure(new Error('callback-fail'));
      },
    };
    const promiseCtx = {
      decodeAudioData() {
        return Promise.reject(new Error('promise-fail'));
      },
    };
    await expect(decodeToBuffer(callbackCtx, new ArrayBuffer(1))).rejects.toThrow('callback-fail');
    await expect(decodeToBuffer(promiseCtx, new ArrayBuffer(1))).rejects.toThrow('promise-fail');
  });

  it('settles once when both the callback and the promise fire', async () => {
    const first = { id: 1 };
    const second = { id: 2 };
    const ctx = {
      decodeAudioData(_buffer, success) {
        success(first);
        return Promise.resolve(second);
      },
    };
    await expect(decodeToBuffer(ctx, new ArrayBuffer(1))).resolves.toBe(first);
  });
});

describe('limitBuffer', () => {
  it('returns the same buffer when it is already within the limit', () => {
    const ctx = makeContext();
    const buf = makeBuffer([Float32Array.of(0.25, -0.5, 0.125, 1)], 8);
    expect(limitBuffer(ctx, buf, 0.5)).toBe(buf);
  });

  it('keeps the leading samples up to maxSeconds', () => {
    const ctx = makeContext();
    const buf = makeBuffer(
      [
        Float32Array.of(0.25, -0.5, 0.125, 1),
        Float32Array.of(1, 0.5, 0.25, 0.125),
      ],
      2,
    );
    const trimmed = limitBuffer(ctx, buf, 1);
    expect(trimmed).not.toBe(buf);
    expect(trimmed.length).toBe(2);
    expect(trimmed.sampleRate).toBe(2);
    expect(trimmed.numberOfChannels).toBe(2);
    expect(Array.from(trimmed.getChannelData(0))).toEqual([0.25, -0.5]);
    expect(Array.from(trimmed.getChannelData(1))).toEqual([1, 0.5]);
    expect(Array.from(buf.getChannelData(0))).toEqual([0.25, -0.5, 0.125, 1]);
  });
});

describe('downmixToStereo', () => {
  it('returns mono and stereo buffers unchanged', () => {
    const ctx = makeContext();
    const mono = makeBuffer([Float32Array.of(0.5, -0.5)], 48000);
    const stereo = makeBuffer([Float32Array.of(0.25), Float32Array.of(-0.25)], 48000);
    expect(downmixToStereo(ctx, mono)).toBe(mono);
    expect(downmixToStereo(ctx, stereo)).toBe(stereo);
  });

  it('averages even channels to the left and odd channels to the right', () => {
    const ctx = makeContext();
    const buf = makeBuffer(
      [
        Float32Array.of(0.5, 0),
        Float32Array.of(0.25, 1),
        Float32Array.of(0.125, 0.5),
        Float32Array.of(1, -1),
      ],
      48000,
    );
    const stereo = downmixToStereo(ctx, buf);
    expect(stereo.numberOfChannels).toBe(2);
    expect(stereo.length).toBe(2);
    expect(stereo.sampleRate).toBe(48000);
    expect(Array.from(stereo.getChannelData(0))).toEqual([0.3125, 0.25]);
    expect(Array.from(stereo.getChannelData(1))).toEqual([0.625, 0]);
    expect(Array.from(buf.getChannelData(0))).toEqual([0.5, 0]);
  });
});

describe('resampleIfNeeded', () => {
  it('returns the same buffer when the rate is already low enough', () => {
    delete globalThis.OfflineAudioContext;
    const buf = makeBuffer([Float32Array.of(0.5, -0.5)], 44100);
    expect(resampleIfNeeded(buf)).toBe(buf);
    expect(resampleIfNeeded(buf, 44100)).toBe(buf);
  });

  it('renders through OfflineAudioContext when the rate is above the limit', async () => {
    const rendered = makeBuffer([Float32Array.of(0.25, -0.25)], 48000);
    let constructed = null;
    class FakeOffline {
      constructor(channels, length, sampleRate) {
        this.numberOfChannels = channels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.destination = { id: 'offline' };
        constructed = this;
      }

      createBufferSource() {
        const source = {
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
        };
        this.source = source;
        return source;
      }

      startRendering() {
        return Promise.resolve(rendered);
      }
    }
    globalThis.OfflineAudioContext = FakeOffline;

    const buf = makeBuffer([Float32Array.of(1, -1, 0.5)], 96000);
    await expect(resampleIfNeeded(buf, 48000)).resolves.toBe(rendered);
    expect(constructed.numberOfChannels).toBe(1);
    expect(constructed.length).toBe(2);
    expect(constructed.sampleRate).toBe(48000);
    expect(constructed.source.buffer).toBe(buf);
    expect(constructed.source.connect).toHaveBeenCalledWith(constructed.destination);
    expect(constructed.source.start).toHaveBeenCalledWith(0);
  });

  it('uses webkitOfflineAudioContext when the standard constructor is missing', async () => {
    delete globalThis.OfflineAudioContext;
    const rendered = { rendered: true };
    globalThis.webkitOfflineAudioContext = class {
      constructor(channels, length, sampleRate) {
        this.channels = channels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.destination = {};
      }

      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }

      startRendering() {
        return Promise.resolve(rendered);
      }
    };
    const buf = makeBuffer([Float32Array.of(0.5, 0.25)], 88200);
    await expect(resampleIfNeeded(buf)).resolves.toBe(rendered);
  });
});

describe('validateRecording', () => {
  it('accepts a clip of at least 0.25s with a peak of 1e-4', () => {
    const frames = 12000;
    const samples = new Float32Array(frames);
    samples[frames - 1] = 1e-4;
    const buf = makeBuffer([new Float32Array(frames), samples], 48000);
    expect(validateRecording(buf)).toEqual({ ok: true });
  });

  it('rejects clips shorter than 0.25s', () => {
    const buf = makeBuffer([Float32Array.of(0.5, -0.5, 0.25)], 48000);
    expect(validateRecording(buf)).toEqual({ ok: false, reason: 'empty' });
    const almost = makeBuffer([new Float32Array(11999)], 48000);
    almost.getChannelData(0)[0] = 1;
    expect(validateRecording(almost)).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a long clip whose peak stays under 1e-4', () => {
    const samples = new Float32Array(12000);
    samples.fill(9.9e-5);
    samples[10] = -9.9e-5;
    expect(validateRecording(makeBuffer([samples], 48000))).toEqual({ ok: false, reason: 'empty' });
  });
});
