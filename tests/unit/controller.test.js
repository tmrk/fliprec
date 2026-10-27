import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAudioContext } from './helpers/fakeAudio.js';

const hooks = vi.hoisted(() => {
  const api = {
    playerState: { state: 'stopped', direction: 'forward', position: 0 },
    playerCb: null,
    interrupt: null,
    recorderOptions: null,
  };

  api.emit = () => {
    if (api.playerCb) {
      api.playerCb({ state: api.playerState.state, direction: api.playerState.direction });
    }
  };

  api.recorder = {
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    getLevel: vi.fn(() => 0.42),
    getElapsed: vi.fn(() => 3),
    cleanup: vi.fn(),
  };

  api.player = {
    load: vi.fn(),
    play: vi.fn((direction, offset) => {
      api.playerState.state = 'playing';
      api.playerState.direction = direction;
      api.playerState.position = offset || 0;
      api.emit();
    }),
    pause: vi.fn(() => {
      if (api.playerState.state !== 'playing') return;
      api.playerState.state = 'paused';
      api.emit();
    }),
    resume: vi.fn(() => {
      if (api.playerState.state !== 'paused') return;
      api.playerState.state = 'playing';
      api.emit();
    }),
    seek: vi.fn((seconds) => {
      api.playerState.position = seconds;
      if (api.playerState.state !== 'playing') api.playerState.state = 'paused';
      api.emit();
    }),
    stop: vi.fn(() => {
      const changed = api.playerState.state !== 'stopped';
      api.playerState.state = 'stopped';
      if (changed) api.emit();
    }),
    getPosition: vi.fn(() => (api.playerState.state === 'stopped' ? 0 : api.playerState.position)),
    getDuration: vi.fn(() => 0),
    getState: vi.fn(() => ({ state: api.playerState.state, direction: api.playerState.direction })),
    onChange: vi.fn((cb) => {
      api.playerCb = cb;
    }),
    dispose: vi.fn(),
  };

  return api;
});

vi.mock('../../src/audio/recorder.js', () => ({
  createRecorder: vi.fn((options) => {
    hooks.recorderOptions = options;
    return hooks.recorder;
  }),
}));

vi.mock('../../src/audio/player.js', () => ({
  createPlayer: vi.fn(() => hooks.player),
}));

vi.mock('../../src/audio/context.js', () => ({
  unlock: vi.fn(),
  getContext: vi.fn(),
  onContextInterrupted: vi.fn((cb) => {
    hooks.interrupt = cb;
  }),
  setAudioSessionType: vi.fn(),
}));

vi.mock('../../src/audio/decode.js', async () => {
  const actual = await vi.importActual('../../src/audio/decode.js');
  return {
    ...actual,
    decodeToBuffer: vi.fn(),
    resampleIfNeeded: vi.fn(async (buf) => buf),
  };
});

vi.mock('../../src/audio/m4a.js', () => ({
  encodeM4A: vi.fn(),
  m4aFile: (buffer, filename) => new File([buffer], filename, { type: 'audio/mp4' }),
}));

vi.mock('../../src/audio/persist.js', () => ({
  save: vi.fn(async () => true),
  load: vi.fn(async () => null),
  clear: vi.fn(async () => true),
}));

vi.mock('../../src/lib/share.js', () => ({
  canShareFiles: vi.fn(() => true),
  shareFiles: vi.fn(async () => 'shared'),
  downloadBlob: vi.fn(),
}));

vi.mock('../../src/lib/analytics.js', () => ({
  track: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  initAnalytics: vi.fn(),
  analyticsAvailable: () => false,
}));

vi.mock('../../src/lib/haptics.js', () => ({
  tap: vi.fn(),
}));

import { decodeToBuffer, resampleIfNeeded } from '../../src/audio/decode.js';
import { encodeM4A } from '../../src/audio/m4a.js';
import { getContext, unlock } from '../../src/audio/context.js';
import { clear as clearPersisted, load as loadPersisted, save as savePersisted } from '../../src/audio/persist.js';
import { grant, revoke, track } from '../../src/lib/analytics.js';
import { tap } from '../../src/lib/haptics.js';
import { canShareFiles, downloadBlob, shareFiles } from '../../src/lib/share.js';
import { TRANSPORT_EVENT, controller, setPreviewModel } from '../../src/engine/controller.js';
import { store } from '../../src/engine/store.js';

const { recorder, player } = hooks;

function makeTone(ctx, seconds, value = 0.25, rate = 8000) {
  const length = Math.max(1, Math.round(seconds * rate));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = value * ((i + 1) / length);
  return buffer;
}

function makeSilent(ctx, seconds = 1, rate = 8000) {
  return ctx.createBuffer(1, Math.max(1, Math.round(seconds * rate)), rate);
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function setHidden(value) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function recordClip() {
  controller.toggleRecord();
  await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
  controller.toggleRecord();
  await vi.waitFor(() => expect(store.getState().phase).toBe('ready'));
}

async function waitExports() {
  await vi.waitFor(() => {
    const exp = store.getState().exports;
    expect(exp.reversed.status).toBe('ready');
    expect(exp.original.status).toBe('ready');
  });
}

describe('controller', () => {
  let ctx;

  beforeEach(async () => {
    setPreviewModel(null);
    setHidden(false);
    controller.clearRecording();
    controller.dismissToast();
    controller.dismissError();
    controller.closeSheet();
    await flush();
    controller.dismissToast();

    hooks.playerState.state = 'stopped';
    hooks.playerState.direction = 'forward';
    hooks.playerState.position = 0;

    ctx = createFakeAudioContext({ sampleRate: 8000 });
    getContext.mockReset();
    getContext.mockReturnValue(ctx);
    unlock.mockReset();

    recorder.start.mockReset();
    recorder.stop.mockReset();
    recorder.cancel.mockClear();
    recorder.getLevel.mockClear();
    recorder.getElapsed.mockClear();
    recorder.start.mockResolvedValue(undefined);
    recorder.stop.mockResolvedValue({
      blob: new Blob(['abc'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      elapsed: 1,
    });

    player.load.mockClear();
    player.play.mockClear();
    player.pause.mockClear();
    player.resume.mockClear();
    player.seek.mockClear();
    player.stop.mockClear();

    decodeToBuffer.mockReset();
    decodeToBuffer.mockImplementation(async () => makeTone(ctx, 1));
    resampleIfNeeded.mockReset();
    resampleIfNeeded.mockImplementation((buf) => Promise.resolve(buf));

    encodeM4A.mockReset();
    encodeM4A.mockImplementation(async ({ channels }) => {
      for (let i = 0; i < channels.length; i += 1) channels[i].fill(0);
      return { buffer: new Uint8Array([1, 2, 3, 4]).buffer, encoder: 'native' };
    });

    canShareFiles.mockReset();
    canShareFiles.mockReturnValue(true);
    shareFiles.mockReset();
    shareFiles.mockResolvedValue('shared');
    downloadBlob.mockReset();

    savePersisted.mockReset();
    savePersisted.mockResolvedValue(true);
    loadPersisted.mockReset();
    loadPersisted.mockResolvedValue(null);
    clearPersisted.mockReset();
    clearPersisted.mockResolvedValue(true);

    track.mockReset();
    grant.mockClear();
    revoke.mockClear();
    tap.mockClear();
  });

  afterEach(() => {
    setPreviewModel(null);
    setHidden(false);
  });

  afterAll(() => {
    delete document.hidden;
  });

  it('returns to empty with mic-denied and keeps an existing recording when a later take fails', async () => {
    recorder.start.mockRejectedValueOnce(Object.assign(new Error('denied'), { kind: 'mic-denied' }));
    controller.toggleRecord();
    expect(store.getState().phase).toBe('requesting');
    await vi.waitFor(() => expect(store.getState().error?.kind).toBe('mic-denied'));
    expect(store.getState().phase).toBe('empty');
    expect(store.getState().recording).toBeNull();

    recorder.start.mockResolvedValue(undefined);
    await recordClip();
    const recording = store.getState().recording;
    expect(recording).toBeTruthy();
    expect(track).toHaveBeenCalledWith('recording_completed', { duration_bucket: '<5s' });

    recorder.start.mockRejectedValueOnce(Object.assign(new Error('denied'), { kind: 'mic-denied' }));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().error?.kind).toBe('mic-denied'));
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().recording).toBe(recording);

    controller.dismissError();
    recorder.stop.mockResolvedValueOnce({ blob: new Blob([]), mimeType: '', elapsed: 0 });
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().toast?.message).toBe('Nothing was recorded. Try again.'));
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().recording).toBe(recording);
  });

  it('ignores a busy start and maps unknown failures to record-failed', async () => {
    recorder.start.mockRejectedValueOnce(Object.assign(new Error('busy'), { kind: 'busy' }));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('empty'));
    expect(store.getState().error).toBeNull();

    recorder.start.mockRejectedValueOnce(Object.assign(new Error('odd'), { kind: 'weird' }));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().error?.kind).toBe('record-failed'));
    expect(store.getState().phase).toBe('empty');
  });

  it('starts only once when toggleRecord is hammered during the permission prompt', async () => {
    let release;
    unlock.mockImplementation(() => {
      expect(recorder.start).not.toHaveBeenCalled();
    });
    recorder.start.mockImplementation(() => {
      expect(unlock).toHaveBeenCalled();
      expect(store.getState().phase).toBe('requesting');
      expect(store.getState().error).toBeNull();
      return new Promise((resolve) => {
        release = resolve;
      });
    });

    for (let i = 0; i < 5; i += 1) controller.toggleRecord();
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock.mock.invocationCallOrder[0]).toBeLessThan(player.stop.mock.invocationCallOrder[0]);
    expect(player.stop.mock.invocationCallOrder[0]).toBeLessThan(recorder.start.mock.invocationCallOrder[0]);
    expect(store.getState().phase).toBe('requesting');
    expect(hooks.recorderOptions.maxSeconds).toBe(120);
    expect(controller.maxSeconds).toBe(120);
    release();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    expect(track).toHaveBeenCalledWith('recording_started');
    expect(tap).toHaveBeenCalled();
  });

  it('drops a stale start after a later take has already been adopted', async () => {
    let releaseFirst;
    recorder.start.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFirst = resolve;
    }));
    controller.toggleRecord();
    expect(store.getState().phase).toBe('requesting');

    setHidden(true);
    await vi.waitFor(() => expect(store.getState().phase).toBe('empty'));
    expect(store.getState().toast).toBeNull();
    expect(store.getState().error).toBeNull();

    setHidden(false);
    await recordClip();
    const recording = store.getState().recording;
    expect(recording.source).toBe('mic');

    releaseFirst();
    await flush();
    expect(store.getState().recording).toBe(recording);
    expect(store.getState().phase).toBe('ready');
    expect(recorder.cancel).toHaveBeenCalled();
    expect(store.getState().toast?.message).not.toBe('Nothing was recorded. Try again.');
  });

  it('discards a late export from an older session', async () => {
    let releaseEncode;
    encodeM4A.mockImplementationOnce(() => new Promise((resolve) => {
      releaseEncode = () => resolve({
        buffer: new Uint8Array([7, 7, 7, 7]).buffer,
        encoder: 'native',
      });
    }));

    await recordClip();
    expect(store.getState().exports.reversed.status).toBe('encoding');
    await recordClip();
    await waitExports();

    controller.share('reversed');
    const firstFile = shareFiles.mock.calls[0][0];
    releaseEncode();
    await flush();
    shareFiles.mockClear();
    controller.share('reversed');
    const secondFile = shareFiles.mock.calls[0][0];
    expect(secondFile).toBe(firstFile);
    const bytes = new Uint8Array(await secondFile.arrayBuffer());
    expect(bytes[0]).toBe(1);
  });

  it('plays, pauses, resumes, and switches direction without a second source', async () => {
    await recordClip();
    player.play.mockClear();
    player.pause.mockClear();
    player.resume.mockClear();
    track.mockClear();
    tap.mockClear();
    unlock.mockClear();

    controller.togglePlay('forward');
    controller.togglePlay('forward');
    controller.togglePlay('forward');
    controller.togglePlay('reverse');

    expect(player.play.mock.calls).toEqual([['forward', 0], ['reverse', 0]]);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect(player.play.mock.invocationCallOrder[0]).toBeLessThan(player.pause.mock.invocationCallOrder[0]);
    expect(player.pause.mock.invocationCallOrder[0]).toBeLessThan(player.resume.mock.invocationCallOrder[0]);
    expect(player.resume.mock.invocationCallOrder[0]).toBeLessThan(player.play.mock.invocationCallOrder[1]);
    expect(track.mock.calls.map((call) => call[0])).toEqual(['played_forward', 'played_reverse']);
    expect(tap).toHaveBeenCalledTimes(4);
    expect(unlock).toHaveBeenCalled();
    expect(store.getState().playback).toEqual({ state: 'playing', direction: 'reverse' });
  });

  it('seeks from stopped into paused and refreshes transport', async () => {
    await recordClip();
    const duration = controller.getDuration();
    expect(duration).toBeCloseTo(1);
    const seen = [];
    const onTransport = () => seen.push(TRANSPORT_EVENT);
    window.addEventListener(TRANSPORT_EVENT, onTransport);
    controller.seek(0.25);
    window.removeEventListener(TRANSPORT_EVENT, onTransport);

    expect(player.seek).toHaveBeenCalledWith(duration * 0.25);
    expect(store.getState().playback.state).toBe('paused');
    expect(store.getState().playback.direction).toBe('forward');
    expect(controller.getPosition()).toBeCloseTo(duration * 0.25);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('toasts when the share file is missing and shares synchronously once it is ready', async () => {
    const navShare = vi.fn();
    Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: navShare });

    let releaseEncode;
    encodeM4A.mockImplementationOnce(() => new Promise((resolve) => {
      releaseEncode = () => resolve({
        buffer: new Uint8Array([1, 2, 3, 4]).buffer,
        encoder: 'native',
      });
    }));
    await recordClip();
    controller.share('reversed');
    expect(store.getState().toast?.message).toBe('Preparing audio...');
    expect(shareFiles).not.toHaveBeenCalled();
    expect(navShare).not.toHaveBeenCalled();

    releaseEncode();
    await waitExports();
    const order = [];
    track.mockImplementation((name) => order.push(name));
    shareFiles.mockImplementation(() => {
      order.push('shareFiles');
      return Promise.resolve('cancelled');
    });
    const result = controller.share('reversed');
    expect(result).toBeUndefined();
    expect(order).toEqual(['share_initiated', 'shareFiles']);
    expect(shareFiles).toHaveBeenCalledTimes(1);
    expect(navShare).not.toHaveBeenCalled();
    await flush();
    expect(track).toHaveBeenCalledWith('share_cancelled');
    expect(track).not.toHaveBeenCalledWith('share_completed');
  });

  it('toasts on activation loss and falls back to download for other share failures', async () => {
    await recordClip();
    await waitExports();

    shareFiles.mockRejectedValueOnce(Object.assign(new Error('gesture'), { kind: 'activation' }));
    controller.share('reversed');
    await vi.waitFor(() => expect(store.getState().toast?.message).toBe('Tap Share again'));
    expect(downloadBlob).not.toHaveBeenCalled();

    controller.dismissToast();
    shareFiles.mockRejectedValueOnce(new Error('nope'));
    controller.share('reversed');
    await vi.waitFor(() => {
      expect(store.getState().toast?.message).toBe("Sharing isn't available here, so the file was saved instead");
    });
    expect(downloadBlob).toHaveBeenCalled();

    controller.dismissToast();
    downloadBlob.mockClear();
    canShareFiles.mockReturnValue(false);
    controller.share('original');
    expect(shareFiles).toHaveBeenCalledTimes(2);
    expect(downloadBlob).toHaveBeenCalled();
    expect(store.getState().toast?.message).toBe("Sharing isn't available here, so the file was saved instead");
  });

  it('toasts when an export fails', async () => {
    encodeM4A.mockRejectedValue(new Error('encode failed'));
    await recordClip();
    await vi.waitFor(() => expect(store.getState().exports.reversed.status).toBe('error'));
    controller.share('reversed');
    expect(store.getState().toast?.message).toBe("Couldn't prepare audio");
    expect(shareFiles).not.toHaveBeenCalled();
  });

  it('restores the recording, peaks, and files after undo', async () => {
    await recordClip();
    await waitExports();
    const recording = store.getState().recording;
    const peaks = controller.getPeaks('forward');
    expect(peaks.length).toBe(2048);
    expect(controller.getPeaks('forward')).toBe(peaks);

    controller.share('reversed');
    const file = shareFiles.mock.calls[0][0];
    controller.openSheet();
    controller.clearRecording();

    expect(store.getState().phase).toBe('empty');
    expect(store.getState().sheetOpen).toBe(false);
    expect(store.getState().recording).toBeNull();
    expect(store.getState().toast?.message).toBe('Recording deleted');
    expect(store.getState().toast?.actionLabel).toBe('Undo');
    await vi.waitFor(() => expect(clearPersisted).toHaveBeenCalled());

    savePersisted.mockClear();
    shareFiles.mockClear();
    store.getState().toast.action();

    expect(store.getState().phase).toBe('ready');
    expect(store.getState().recording).toBe(recording);
    expect(controller.getPeaks('forward')).toBe(peaks);
    expect(store.getState().exports.reversed.status).toBe('ready');
    expect(store.getState().toast).toBeNull();
    controller.share('reversed');
    expect(shareFiles.mock.calls[0][0]).toBe(file);
    await vi.waitFor(() => expect(savePersisted).toHaveBeenCalled());
  });

  it('caches peaks, reports level only while recording, and buckets duration', async () => {
    expect(controller.getLevel()).toBe(0);
    expect(controller.getElapsed()).toBe(0);
    expect(controller.getLevelHistory(8)).toBeNull();
    expect(controller.getPeaks('forward')).toEqual([]);

    const buckets = [
      [1, '<5s'],
      [5, '5-15s'],
      [15, '15-30s'],
      [30, '30-60s'],
      [60, '60-120s'],
    ];
    for (let i = 0; i < buckets.length; i += 1) {
      const [seconds, bucket] = buckets[i];
      decodeToBuffer.mockImplementationOnce(async () => makeTone(ctx, seconds, 0.25, 100));
      track.mockClear();
      await recordClip();
      expect(track).toHaveBeenCalledWith('recording_completed', { duration_bucket: bucket });
    }

    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    expect(controller.getLevel()).toBe(0.42);
    expect(controller.getElapsed()).toBe(3);
    const cached = controller.getPeaks('reverse');
    expect(cached).toBe(controller.getPeaks('reverse'));
    expect(cached.length).toBe(2048);
  });

  it('toasts the limit and an interruption without a second haptic', async () => {
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    expect(tap).toHaveBeenCalledTimes(1);
    hooks.recorderOptions.onAutoStop();
    await vi.waitFor(() => expect(store.getState().phase).toBe('ready'));
    expect(store.getState().toast?.message).toBe('2-minute limit reached');
    expect(tap).toHaveBeenCalledTimes(1);

    controller.dismissToast();
    tap.mockClear();
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    expect(tap).toHaveBeenCalledTimes(1);
    setHidden(true);
    await vi.waitFor(() => expect(store.getState().phase).toBe('ready'));
    expect(store.getState().toast?.message).toBe('Recording stopped when FlipRec went to the background');
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('pauses playback when the page hides or the audio context is interrupted', async () => {
    await recordClip();
    controller.togglePlay('forward');
    expect(store.getState().playback.state).toBe('playing');
    setHidden(true);
    expect(player.pause).toHaveBeenCalled();
    expect(store.getState().playback.state).toBe('paused');

    controller.togglePlay('forward');
    expect(store.getState().playback.state).toBe('playing');
    hooks.interrupt();
    expect(store.getState().playback.state).toBe('paused');
  });

  it('imports a trimmed file and restores the previous recording when decode fails', async () => {
    await recordClip();
    const recording = store.getState().recording;

    resampleIfNeeded.mockImplementation((buf) => buf);
    decodeToBuffer.mockResolvedValueOnce(makeTone(ctx, 301, 0.25, 100));
    const file = new File([new Uint8Array(16)], 'clip.wav', { type: 'audio/wav' });
    controller.importFile(file);
    expect(store.getState().phase).toBe('processing');
    await vi.waitFor(() => expect(store.getState().phase).toBe('ready'));
    expect(store.getState().recording.source).toBe('import');
    expect(store.getState().recording.duration).toBeLessThanOrEqual(300);
    expect(store.getState().toast?.message).toBe('Imported the first 5 minutes');
    expect(track).toHaveBeenCalledWith('audio_imported');

    const imported = store.getState().recording;
    decodeToBuffer.mockRejectedValueOnce(new Error('bad file'));
    controller.importFile(file);
    await vi.waitFor(() => {
      expect(store.getState().toast?.message).toBe("That file couldn't be opened as audio");
    });
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().recording).toBe(imported);
    expect(imported).not.toBe(recording);

    controller.dismissToast();
    const phase = store.getState().phase;
    decodeToBuffer.mockClear();
    controller.importFile({ size: 200 * 1024 * 1024 + 1, type: 'audio/wav' });
    expect(store.getState().phase).toBe(phase);
    expect(store.getState().toast?.message).toBe('That file is too large');
    expect(decodeToBuffer).not.toHaveBeenCalled();
  });

  it('downloads a ready m4a and a wav that still has energy after encode', async () => {
    await recordClip();
    await waitExports();

    controller.download('reversed', 'm4a');
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('download_reversed');

    downloadBlob.mockClear();
    track.mockClear();
    controller.download('reversed', 'wav');
    expect(track).toHaveBeenCalledWith('download_reversed');
    const [blob, name] = downloadBlob.mock.calls[0];
    expect(name).toMatch(/^fliprec-reversed-\d{8}-\d{6}\.wav$/);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('RIFF');
    const sample = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(44, true);
    expect(Math.abs(sample)).toBeGreaterThan(1000);
  });

  it('restores a persisted recording and ignores a decode failure', async () => {
    const blob = new Blob(['stored'], { type: 'audio/webm' });
    loadPersisted.mockResolvedValueOnce({
      blob,
      mimeType: 'audio/webm',
      createdAt: 1700000000000,
      source: 'mic',
    });
    const phases = [];
    const unsubscribe = store.subscribe(() => phases.push(store.getState().phase));
    await controller.restore();
    unsubscribe();
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().recording.createdAt).toBe(1700000000000);
    expect(store.getState().recording.source).toBe('mic');
    expect(phases).not.toContain('processing');

    controller.clearRecording();
    controller.dismissToast();
    await flush();
    loadPersisted.mockResolvedValueOnce({
      blob,
      mimeType: 'audio/webm',
      createdAt: 5,
      source: 'mic',
    });
    decodeToBuffer.mockRejectedValueOnce(new Error('corrupt'));
    await controller.restore();
    expect(store.getState().phase).toBe('empty');
    expect(store.getState().recording).toBeNull();
    expect(store.getState().toast).toBeNull();
  });

  it('delegates getters to the preview model and leaves the engine alone', async () => {
    expect(controller.getLevelHistory(4)).toBeNull();
    const model = {
      getLevel: () => 0.7,
      getElapsed: () => 12,
      getPosition: () => 3,
      getDuration: () => 9,
      getPeaks: (direction) => (direction === 'reverse' ? null : [0.2]),
      getLevelHistory: (count) => [count],
      seek: vi.fn(),
    };
    setPreviewModel(model);
    expect(controller.getLevel()).toBe(0.7);
    expect(controller.getElapsed()).toBe(12);
    expect(controller.getPosition()).toBe(3);
    expect(controller.getDuration()).toBe(9);
    expect(controller.getPeaks('forward')).toEqual([0.2]);
    expect(controller.getPeaks('reverse')).toEqual([]);
    expect(controller.getLevelHistory(4)).toEqual([4]);

    const seen = [];
    window.addEventListener(TRANSPORT_EVENT, () => seen.push(1));
    controller.seek(2);
    expect(model.seek).toHaveBeenCalledWith(1);
    expect(seen.length).toBeGreaterThan(0);

    const starts = recorder.start.mock.calls.length;
    controller.toggleRecord();
    controller.togglePlay('forward');
    controller.share('reversed');
    controller.importFile(new File(['a'], 'a.wav'));
    await flush();
    expect(recorder.start).toHaveBeenCalledTimes(starts);
    expect(store.getState().phase).toBe('empty');
  });

  it('keeps consent and theme wired through the store', () => {
    controller.setConsent(true);
    expect(store.getState().consent).toBe('granted');
    expect(grant).toHaveBeenCalledTimes(1);
    controller.setConsent(false);
    expect(store.getState().consent).toBe('denied');
    expect(revoke).toHaveBeenCalledTimes(1);

    controller.setTheme('light');
    expect(store.getState().theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('fliprec:theme')).toBe('light');
  });

  it('treats a silent buffer and a decode error as failed takes', async () => {
    await recordClip();
    const recording = store.getState().recording;

    decodeToBuffer.mockResolvedValueOnce(makeSilent(ctx));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().toast?.message).toBe('Nothing was recorded. Try again.'));
    expect(store.getState().recording).toBe(recording);

    controller.dismissToast();
    decodeToBuffer.mockRejectedValueOnce(new Error('decode'));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().toast?.message).toBe("Couldn't process the recording"));
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().recording).toBe(recording);
  });

  it('awaits a synchronous resample and restores silently when a start is cancelled', async () => {
    resampleIfNeeded.mockImplementation((buf) => buf);
    await recordClip();
    expect(store.getState().recording.duration).toBeCloseTo(1);

    const recording = store.getState().recording;
    recorder.start.mockResolvedValueOnce({ cancelled: true });
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('ready'));
    expect(store.getState().recording).toBe(recording);
    expect(store.getState().toast).toBeNull();
    expect(store.getState().error).toBeNull();
  });
});
