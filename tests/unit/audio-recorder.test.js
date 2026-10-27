import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecorder } from '../../src/audio/recorder.js';
import {
  allocatedTracks,
  createFakeAudioContext,
  createFakeStream,
  installFakeMediaRecorder,
  installFakeUserMedia,
} from './helpers/fakeAudio.js';

const AUDIO_CONSTRAINTS = {
  audio: {
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

let ctx;
let media;
let userMedia;
let session;

function liveSince(index) {
  return allocatedTracks().slice(index).filter((track) => track.readyState === 'live');
}

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

beforeEach(() => {
  ctx = createFakeAudioContext({ sampleRate: 48000 });
  media = installFakeMediaRecorder({
    chunks: [new Blob(['one']), new Blob(['two']), new Blob(['three'])],
    supported: (mime) => mime === 'audio/webm;codecs=opus',
  });
  userMedia = installFakeUserMedia(async () => createFakeStream());
  session = { type: 'playback' };
  navigator.audioSession = session;
});

afterEach(() => {
  vi.useRealTimers();
  media.restore();
  userMedia.restore();
  delete navigator.audioSession;
  delete document.hidden;
  vi.restoreAllMocks();
});

function makeRecorder(options = {}) {
  return createRecorder({
    getContext: () => ctx,
    onAutoStop: options.onAutoStop,
    onInterrupted: options.onInterrupted,
    maxSeconds: options.maxSeconds ?? 120,
  });
}

describe('createRecorder errors', () => {
  it('maps permission denial to mic-denied and leaves no live tracks', async () => {
    const before = allocatedTracks().length;
    userMedia.mediaDevices.getUserMedia.mockRejectedValue(namedError('NotAllowedError', 'denied'));
    const recorder = makeRecorder();

    const error = await recorder.start().catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('mic-denied');
    expect(recorder.state).toBe('idle');
    expect(liveSince(before)).toEqual([]);
    expect(media.instances).toHaveLength(0);
    expect(session.type).toBe('playback');

    userMedia.mediaDevices.getUserMedia.mockRejectedValue(namedError('SecurityError', 'blocked'));
    const again = await recorder.start().catch((caught) => caught);
    expect(again.kind).toBe('mic-denied');
  });

  it('maps a missing microphone to mic-missing', async () => {
    const recorder = makeRecorder();
    userMedia.mediaDevices.getUserMedia.mockRejectedValue(namedError('NotFoundError', 'none'));
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'mic-missing' });

    userMedia.mediaDevices.getUserMedia.mockRejectedValue(namedError('OverconstrainedError', 'bad'));
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'mic-missing' });
    expect(recorder.state).toBe('idle');
  });

  it('reports unsupported when capture APIs are missing', async () => {
    const recorder = makeRecorder();
    delete globalThis.MediaRecorder;
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'unsupported' });
    expect(session.type).toBe('playback');
  });

  it('stops tracks acquired before a recorder failure', async () => {
    const stream = createFakeStream();
    userMedia.mediaDevices.getUserMedia.mockResolvedValue(stream);
    globalThis.MediaRecorder = class {
      constructor() {
        throw new Error('cannot record');
      }

      static isTypeSupported() {
        return false;
      }
    };
    const recorder = makeRecorder();
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'record-failed' });
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(stream.getTracks()[0].readyState).toBe('ended');
    expect(recorder.state).toBe('idle');
  });
});

describe('createRecorder capture', () => {
  it('returns chunks in order with the chosen mime type', async () => {
    const onInterrupted = vi.fn();
    const recorder = makeRecorder({ onInterrupted });
    expect(recorder.state).toBe('idle');

    await recorder.start();
    expect(recorder.state).toBe('recording');
    expect(session.type).toBe('play-and-record');
    expect(userMedia.mediaDevices.getUserMedia).toHaveBeenCalledWith(AUDIO_CONSTRAINTS);
    expect(media.instances).toHaveLength(1);
    expect(media.instances[0].timeslice).toBeUndefined();
    expect(media.instances[0].recorderOptions).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000,
    });
    expect(ctx.analysers[0].fftSize).toBe(1024);
    expect(ctx.streamSources[0].connect).toHaveBeenCalledTimes(1);
    expect(ctx.streamSources[0].connect).toHaveBeenCalledWith(ctx.analysers[0]);
    // The analyser may only feed a muted sink (keeps WebKit processing it, never audible).
    const analyserTargets = ctx.analysers[0].connect.mock.calls.map((call) => call[0]);
    expect(analyserTargets).toHaveLength(1);
    expect(analyserTargets[0].gain.value).toBe(0);

    media.instances[0].mimeType = '';
    const result = await recorder.stop();
    expect(recorder.state).toBe('idle');
    expect(result.mimeType).toBe('audio/webm;codecs=opus');
    expect(result.blob.type).toBe('audio/webm;codecs=opus');
    expect(await result.blob.text()).toBe('onetwothree');
    expect(result.elapsed).toBeGreaterThanOrEqual(0);
    expect(session.type).toBe('playback');
    expect(onInterrupted).not.toHaveBeenCalled();
    expect(ctx.streamSources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.analysers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects a second start while busy', async () => {
    let resolveMic;
    userMedia.mediaDevices.getUserMedia.mockImplementation(() => new Promise((resolve) => {
      resolveMic = resolve;
    }));
    const recorder = makeRecorder();
    const first = recorder.start();
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'busy' });
    expect(recorder.state).toBe('starting');

    resolveMic(createFakeStream());
    await first;
    expect(recorder.state).toBe('recording');
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'busy' });
    expect(media.instances).toHaveLength(1);
  });

  it('releases the stream when stop is called while permission is pending', async () => {
    let resolveMic;
    userMedia.mediaDevices.getUserMedia.mockImplementation(() => new Promise((resolve) => {
      resolveMic = resolve;
    }));
    const recorder = makeRecorder();
    const starting = recorder.start();
    const stopping = recorder.stop();
    expect(recorder.state).toBe('starting');

    const stream = createFakeStream();
    resolveMic(stream);
    await expect(starting).resolves.toEqual({ cancelled: true });
    await expect(stopping).resolves.toMatchObject({ mimeType: '', elapsed: 0 });
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(stream.getTracks()[0].readyState).toBe('ended');
    expect(recorder.state).toBe('idle');
    expect(media.instances).toHaveLength(0);
    expect(session.type).toBe('playback');
  });

  it('releases the stream when cancel is called while permission is pending', async () => {
    let resolveMic;
    userMedia.mediaDevices.getUserMedia.mockImplementation(() => new Promise((resolve) => {
      resolveMic = resolve;
    }));
    const recorder = makeRecorder();
    const starting = recorder.start();
    recorder.cancel();
    const stream = createFakeStream();
    resolveMic(stream);
    await expect(starting).resolves.toEqual({ cancelled: true });
    expect(stream.getTracks().every((track) => track.readyState === 'ended')).toBe(true);
    expect(recorder.state).toBe('idle');
  });

  it('calls onAutoStop when maxSeconds elapses and does not stop by itself', async () => {
    vi.useFakeTimers();
    const onAutoStop = vi.fn();
    const recorder = makeRecorder({ onAutoStop, maxSeconds: 0.25 });
    await recorder.start();
    await vi.advanceTimersByTimeAsync(249);
    expect(onAutoStop).not.toHaveBeenCalled();
    expect(recorder.state).toBe('recording');
    await vi.advanceTimersByTimeAsync(1);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(recorder.state).toBe('recording');
  });

  it('freezes elapsed time at stop', async () => {
    vi.useFakeTimers();
    const recorder = makeRecorder({ maxSeconds: 30 });
    await recorder.start();
    await vi.advanceTimersByTimeAsync(1800);
    expect(recorder.getElapsed()).toBeCloseTo(1.8, 5);
    const pending = recorder.stop();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.elapsed).toBeCloseTo(1.8, 5);
    expect(recorder.getElapsed()).toBeCloseTo(1.8, 5);
  });

  it('stops every track exactly once when cleanup runs twice', async () => {
    const stream = createFakeStream(2);
    userMedia.mediaDevices.getUserMedia.mockResolvedValue(stream);
    const recorder = makeRecorder();
    await recorder.start();
    recorder.cleanup();
    recorder.cleanup();
    expect(recorder.state).toBe('idle');
    for (const track of stream.getTracks()) {
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(track.readyState).toBe('ended');
    }
    expect(ctx.streamSources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.analysers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(session.type).toBe('playback');
  });

  it('reports interruptions and reuses one level buffer', async () => {
    const onInterrupted = vi.fn();
    const recorder = makeRecorder({ onInterrupted });
    const stream = createFakeStream();
    userMedia.mediaDevices.getUserMedia.mockResolvedValue(stream);
    await recorder.start();

    stream.getTracks()[0].dispatch('ended');
    media.instances[0].dispatch('error');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onInterrupted.mock.calls).toEqual([['ended'], ['error'], ['visibility']]);

    const analyser = ctx.analysers[0];
    const buffers = [];
    analyser.getFloatTimeDomainData = (array) => {
      buffers.push(array);
      array.fill(0.1);
    };
    const first = recorder.getLevel();
    const full = (20 * Math.log10(0.1) + 54) / 48;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(full - 0.05);
    let level = first;
    for (let i = 0; i < 40; i += 1) level = recorder.getLevel();
    expect(level).toBeCloseTo(full, 4);
    expect(buffers.length).toBeGreaterThan(2);
    expect(buffers.every((buffer) => buffer === buffers[0])).toBe(true);
    expect(buffers[0]).toBeInstanceOf(Float32Array);

    await recorder.stop();
    expect(recorder.getLevel()).toBe(0);
    onInterrupted.mockClear();
    stream.getTracks()[0].dispatch('ended');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onInterrupted).not.toHaveBeenCalled();
  });
});

function installStartMode(mode) {
  media.restore();
  media = installFakeMediaRecorder({
    chunks: [new Blob(['one']), new Blob(['two']), new Blob(['three'])],
    supported: (mime) => mime === 'audio/webm;codecs=opus',
    start: mode,
  });
}

describe('createRecorder capture start', () => {
  it('stays starting until the recorder start event', async () => {
    let releaseMic;
    userMedia.mediaDevices.getUserMedia.mockImplementation(() => new Promise((resolve) => {
      releaseMic = resolve;
    }));
    const recorder = makeRecorder();
    const pending = recorder.start();
    const stream = createFakeStream();
    releaseMic(stream);
    await Promise.resolve();
    expect(recorder.state).toBe('starting');
    expect(recorder.getElapsed()).toBe(0);
    expect(media.instances).toHaveLength(1);
    expect(media.instances[0].state).toBe('recording');
    await pending;
    expect(recorder.state).toBe('recording');
    expect(stream.getTracks()[0].readyState).toBe('live');
  });

  it('falls back to recording when the start event never arrives', async () => {
    vi.useFakeTimers();
    installStartMode('none');
    const stream = createFakeStream();
    userMedia.mediaDevices.getUserMedia.mockResolvedValue(stream);
    const recorder = makeRecorder();
    let settled = false;
    const pending = recorder.start().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    expect(recorder.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(recorder.state).toBe('recording');
    expect(stream.getTracks()[0].readyState).toBe('live');
  });

  it('cancels during the capture wait and releases the microphone', async () => {
    vi.useFakeTimers();
    installStartMode('none');
    const stream = createFakeStream();
    userMedia.mediaDevices.getUserMedia.mockResolvedValue(stream);
    const recorder = makeRecorder();
    const pending = recorder.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(recorder.state).toBe('starting');
    expect(media.instances).toHaveLength(1);
    recorder.cancel();
    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(stream.getTracks().every((track) => track.readyState === 'ended')).toBe(true);
    expect(recorder.state).toBe('idle');
    await vi.advanceTimersByTimeAsync(500);
    expect(recorder.state).toBe('idle');
  });

  it('stops during the capture wait and resolves as cancelled', async () => {
    vi.useFakeTimers();
    installStartMode('none');
    const stream = createFakeStream();
    userMedia.mediaDevices.getUserMedia.mockResolvedValue(stream);
    const recorder = makeRecorder();
    const starting = recorder.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(recorder.state).toBe('starting');
    const stopping = recorder.stop();
    await expect(starting).resolves.toEqual({ cancelled: true });
    await expect(stopping).resolves.toMatchObject({ mimeType: '', elapsed: 0 });
    expect(stream.getTracks().every((track) => track.readyState === 'ended')).toBe(true);
    expect(recorder.state).toBe('idle');
  });

  it('rejects record-failed when the recorder errors before start', async () => {
    installStartMode('error');
    const stream = createFakeStream();
    userMedia.mediaDevices.getUserMedia.mockResolvedValue(stream);
    const onInterrupted = vi.fn();
    const recorder = makeRecorder({ onInterrupted });
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'record-failed' });
    expect(recorder.state).toBe('idle');
    expect(recorder.getElapsed()).toBe(0);
    expect(stream.getTracks().every((track) => track.readyState === 'ended')).toBe(true);
    expect(onInterrupted).not.toHaveBeenCalled();
    expect(session.type).toBe('playback');
  });
});

describe('createRecorder start hold', () => {
  async function armHold(notBefore) {
    let resolveMic;
    userMedia.mediaDevices.getUserMedia.mockImplementation(() => new Promise((resolve) => {
      resolveMic = resolve;
    }));
    const recorder = makeRecorder();
    const pending = recorder.start({ notBefore });
    const stream = createFakeStream();
    resolveMic(stream);
    await Promise.resolve();
    await Promise.resolve();
    return { recorder, pending, stream };
  }

  it('delays mediaRecorder.start until notBefore', async () => {
    vi.useFakeTimers();
    const notBefore = performance.now() + 200;
    const { recorder, pending, stream } = await armHold(notBefore);
    expect(media.instances).toHaveLength(1);
    expect(media.instances[0].state).toBe('inactive');
    expect(recorder.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(199);
    expect(media.instances[0].state).toBe('inactive');
    await vi.advanceTimersByTimeAsync(1);
    expect(media.instances[0].state).toBe('recording');
    await pending;
    expect(recorder.state).toBe('recording');
    expect(stream.getTracks()[0].readyState).toBe('live');
  });

  it('cancels during the hold, releases the mic, and never starts capture', async () => {
    vi.useFakeTimers();
    const { recorder, pending: starting, stream } = await armHold(performance.now() + 500);
    expect(media.instances).toHaveLength(1);
    expect(media.instances[0].state).toBe('inactive');
    const startSpy = vi.spyOn(media.instances[0], 'start');
    const stopping = recorder.stop();
    await expect(starting).resolves.toEqual({ cancelled: true });
    await expect(stopping).resolves.toMatchObject({ mimeType: '', elapsed: 0 });
    expect(startSpy).not.toHaveBeenCalled();
    expect(media.instances[0].state).toBe('inactive');
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(stream.getTracks()[0].readyState).toBe('ended');
    expect(recorder.state).toBe('idle');
  });

  it('starts immediately when notBefore is in the past', async () => {
    vi.useFakeTimers();
    const { recorder, pending } = await armHold(performance.now() - 50);
    await pending;
    expect(media.instances[0].state).toBe('recording');
    expect(recorder.state).toBe('recording');
  });
});

