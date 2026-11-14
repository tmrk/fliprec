import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAudioContext } from './helpers/fakeAudio.js';

const hooks = vi.hoisted(() => {
  const api = {
    playerState: { state: 'stopped', direction: 'forward', position: 0 },
    playerCb: null,
    interrupt: null,
    recorderOptions: null,
    renders: [],
    autoRender: true,
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
    replace: vi.fn(),
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

vi.mock('../../src/audio/effects.js', async () => {
  const { renderEffect } = await vi.importActual('../../src/audio/fx.js');
  return {
    renderEffectInWorker: vi.fn(({ channels, sampleRate, effect, signal }) => new Promise((resolve, reject) => {
      const entry = {
        channels,
        sampleRate,
        effect,
        signal,
        resolve: () => resolve(renderEffect(channels, sampleRate, effect)),
        reject,
      };
      hooks.renders.push(entry);
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      if (hooks.autoRender) entry.resolve();
    })),
  };
});

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

vi.mock('../../src/audio/sfx.js', () => ({
  playSfx: vi.fn(() => 0),
  setSfxEnabled: vi.fn(),
}));

import { decodeToBuffer, resampleIfNeeded } from '../../src/audio/decode.js';
import { encodeM4A } from '../../src/audio/m4a.js';
import { renderEffectInWorker } from '../../src/audio/effects.js';
import { getContext, unlock } from '../../src/audio/context.js';
import { clear as clearPersisted, load as loadPersisted, save as savePersisted } from '../../src/audio/persist.js';
import { grant, revoke, track } from '../../src/lib/analytics.js';
import { tap } from '../../src/lib/haptics.js';
import { playSfx, setSfxEnabled } from '../../src/audio/sfx.js';
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
    player.replace.mockClear();
    player.play.mockClear();
    store.setState({ effect: { speed: 1, pitch: 1 } });
    hooks.renders = [];
    hooks.autoRender = true;
    renderEffectInWorker.mockClear();
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
    playSfx.mockReset();
    playSfx.mockReturnValue(0);
    setSfxEnabled.mockClear();
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

  it('plays a cue for each transport and stays silent on ignored taps', async () => {
    playSfx.mockClear();
    controller.togglePlay('forward');
    expect(playSfx).not.toHaveBeenCalled();

    setPreviewModel({
      getLevel: () => 0,
      getElapsed: () => 0,
      getPosition: () => 0,
      getDuration: () => 1,
      getPeaks: () => [],
    });
    controller.togglePlay('reverse');
    expect(playSfx).not.toHaveBeenCalled();
    setPreviewModel(null);

    await recordClip();
    playSfx.mockClear();
    controller.togglePlay('forward');
    controller.togglePlay('forward');
    controller.togglePlay('forward');
    controller.togglePlay('reverse');
    expect(playSfx.mock.calls.map((call) => call[0])).toEqual(['play', 'pause', 'play', 'reverse']);
  });

  it('passes the start cue end as notBefore and plays stop only after recorder.stop resolves', async () => {
    playSfx.mockReturnValue(4321);
    controller.toggleRecord();
    expect(playSfx).toHaveBeenCalledWith('start');
    expect(recorder.start).toHaveBeenCalledWith({ notBefore: 4321 });
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));

    let releaseStop;
    recorder.stop.mockImplementationOnce(() => new Promise((resolve) => {
      releaseStop = resolve;
    }));
    playSfx.mockClear();
    decodeToBuffer.mockClear();
    controller.toggleRecord();
    expect(store.getState().phase).toBe('processing');
    await flush();
    expect(playSfx).not.toHaveBeenCalled();
    expect(decodeToBuffer).not.toHaveBeenCalled();
    releaseStop({
      blob: new Blob(['abc'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      elapsed: 1,
    });
    await vi.waitFor(() => expect(store.getState().phase).toBe('ready'));
    expect(playSfx.mock.calls.map((call) => call[0])).toEqual(['stop']);
    expect(playSfx.mock.invocationCallOrder[0]).toBeLessThan(decodeToBuffer.mock.invocationCallOrder[0]);
  });

  it('plays error on start failure, empty takes, and import failure, never on top of the stop cue', async () => {
    recorder.start.mockRejectedValueOnce(Object.assign(new Error('denied'), { kind: 'mic-denied' }));
    playSfx.mockClear();
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().error?.kind).toBe('mic-denied'));
    expect(playSfx.mock.calls.map((call) => call[0])).toEqual(['start', 'error']);

    recorder.start.mockRejectedValueOnce(Object.assign(new Error('busy'), { kind: 'busy' }));
    playSfx.mockClear();
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('empty'));
    expect(playSfx.mock.calls.map((call) => call[0])).toEqual(['start']);
    expect(store.getState().error).toBeNull();

    recorder.start.mockResolvedValue(undefined);
    await recordClip();
    playSfx.mockClear();
    recorder.stop.mockResolvedValueOnce({ blob: new Blob([]), mimeType: '', elapsed: 0 });
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().toast?.message).toBe('Nothing was recorded. Try again.'));
    expect(playSfx.mock.calls.map((call) => call[0])).toEqual(['start', 'error']);

    controller.dismissToast();
    playSfx.mockClear();
    decodeToBuffer.mockRejectedValueOnce(new Error('decode'));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
    controller.toggleRecord();
    await vi.waitFor(() => expect(store.getState().toast?.message).toBe("Couldn't process the recording"));
    expect(playSfx.mock.calls.map((call) => call[0])).toEqual(['start', 'stop']);

    controller.dismissToast();
    playSfx.mockClear();
    decodeToBuffer.mockRejectedValueOnce(new Error('bad file'));
    controller.importFile(new File([new Uint8Array(16)], 'clip.wav', { type: 'audio/wav' }));
    await vi.waitFor(() => {
      expect(store.getState().toast?.message).toBe("That file couldn't be opened as audio");
    });
    expect(playSfx.mock.calls.map((call) => call[0])).toEqual(['error']);
  });

  it('persists sounds and calls setSfxEnabled', () => {
    playSfx.mockClear();
    setSfxEnabled.mockClear();
    controller.setSounds(false);
    expect(store.getState().sounds).toBe(false);
    expect(localStorage.getItem('fliprec:sounds')).toBe('off');
    expect(setSfxEnabled).toHaveBeenCalledWith(false);
    expect(playSfx).not.toHaveBeenCalled();

    controller.setSounds(true);
    expect(store.getState().sounds).toBe(true);
    expect(localStorage.getItem('fliprec:sounds')).toBe('on');
    expect(setSfxEnabled).toHaveBeenCalledWith(true);
    expect(playSfx).toHaveBeenCalledWith('tap');
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
  describe('speed and pitch', () => {
    function heard() {
      const call = player.replace.mock.calls.at(-1) ?? player.load.mock.calls.at(-1);
      return { forward: call[0], reverse: call[1] };
    }

    function expectExactReversal(forward, reverse) {
      const a = forward.getChannelData(0);
      const b = reverse.getChannelData(0);
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i += 97) expect(b[a.length - 1 - i]).toBe(a[i]);
    }

    it('ignores taps until a take is ready and keeps preview out of the engine', async () => {
      controller.setEffect('speed', 2);
      expect(store.getState().effect).toEqual({ speed: 1, pitch: 1 });

      setPreviewModel({ getDuration: () => 1 });
      controller.setEffect('pitch', 2);
      expect(store.getState().effect).toEqual({ speed: 1, pitch: 2 });
      setPreviewModel(null);
      expect(renderEffectInWorker).not.toHaveBeenCalled();
      expect(player.replace).not.toHaveBeenCalled();
    });

    it('never renders on the neutral path and exports the original take', async () => {
      await recordClip();
      await waitExports();
      expect(renderEffectInWorker).not.toHaveBeenCalled();
      expect(encodeM4A).toHaveBeenCalledTimes(2);
      expect(encodeM4A.mock.calls.every(([arg]) => arg.channels[0].length === 8000)).toBe(true);
      expect(controller.getDuration()).toBeCloseTo(1, 6);
    });

    it('sets speed to 2, then 1/2, then 1 and renders from the original take', async () => {
      await recordClip();
      await waitExports();
      const [originalForward, originalReverse] = player.load.mock.calls.at(-1);

      controller.setEffect('speed', 2);
      expect(store.getState().effect).toEqual({ speed: 2, pitch: 1 });
      expect(track).toHaveBeenCalledWith('effect_changed', { speed: 2, pitch: 1 });
      expect(store.getState().exports.reversed.status).toBe('encoding');
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(1));
      const input = renderEffectInWorker.mock.calls[0][0];
      expect(input.channels[0]).not.toBe(originalForward.getChannelData(0));
      expect(input.channels[0][4000]).toBe(originalForward.getChannelData(0)[4000]);
      let { forward, reverse } = heard();
      expect(Math.abs(forward.length - 4000)).toBeLessThanOrEqual(1);
      expectExactReversal(forward, reverse);
      expect(controller.getDuration()).toBeCloseTo(forward.length / 8000, 6);

      controller.setEffect('speed', 0.5);
      expect(store.getState().effect).toEqual({ speed: 0.5, pitch: 1 });
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(2));
      ({ forward, reverse } = heard());
      expect(forward.length).toBe(16000);
      expectExactReversal(forward, reverse);

      controller.setEffect('speed', 1);
      expect(store.getState().effect).toEqual({ speed: 1, pitch: 1 });
      expect(player.replace).toHaveBeenCalledTimes(3);
      expect(player.replace.mock.calls[2][0]).toBe(originalForward);
      expect(player.replace.mock.calls[2][1]).toBe(originalReverse);
      expect(renderEffectInWorker).toHaveBeenCalledTimes(2);
      expect(controller.getDuration()).toBeCloseTo(1, 6);
    });

    it('drops a superseded render and rebuilds exports once, from the latest sound', async () => {
      await recordClip();
      await waitExports();
      encodeM4A.mockClear();
      hooks.autoRender = false;

      controller.setEffect('speed', 2);
      await vi.waitFor(() => expect(hooks.renders).toHaveLength(1));
      controller.setEffect('pitch', 2);
      await vi.waitFor(() => expect(hooks.renders).toHaveLength(2));
      expect(hooks.renders[0].signal.aborted).toBe(true);
      expect(hooks.renders[1].effect).toEqual({ speed: 2, pitch: 2 });
      hooks.renders[0].resolve();
      hooks.renders[1].resolve();

      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(1));
      await waitExports();
      expect(encodeM4A).toHaveBeenCalledTimes(2);
      const lengths = encodeM4A.mock.calls.map(([arg]) => arg.channels[0].length);
      expect(lengths.every((length) => Math.abs(length - 4000) <= 2)).toBe(true);
    });

    it('waits 400 ms after the last change before encoding', async () => {
      await recordClip();
      await waitExports();
      encodeM4A.mockClear();
      controller.setEffect('pitch', 2);
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(1));
      const landed = performance.now();
      await vi.waitFor(() => expect(encodeM4A).toHaveBeenCalled(), { timeout: 2000 });
      expect(performance.now() - landed).toBeGreaterThanOrEqual(350);
      await waitExports();
    });

    it('falls back to the normal sound and toasts when a render fails', async () => {
      await recordClip();
      await waitExports();
      const [originalForward] = player.load.mock.calls.at(-1);
      hooks.autoRender = false;
      controller.setEffect('speed', 2);
      await vi.waitFor(() => expect(hooks.renders).toHaveLength(1));
      hooks.renders[0].reject(new Error('worker died'));

      await vi.waitFor(() => expect(store.getState().toast?.message).toBe("Couldn't change the sound"));
      expect(store.getState().effect).toEqual({ speed: 1, pitch: 1 });
      expect(player.replace.mock.calls.at(-1)[0]).toBe(originalForward);
      await waitExports();
    });

    it('renders a new take before it becomes ready when an effect is on', async () => {
      await recordClip();
      controller.setEffect('speed', 2);
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(1));
      await waitExports();
      encodeM4A.mockClear();
      hooks.autoRender = false;

      controller.toggleRecord();
      await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
      controller.toggleRecord();
      await vi.waitFor(() => expect(hooks.renders).toHaveLength(2));
      expect(store.getState().phase).toBe('processing');
      expect(encodeM4A).not.toHaveBeenCalled();
      hooks.renders[1].resolve();

      await vi.waitFor(() => expect(store.getState().phase).toBe('ready'));
      const [forward, reverse] = player.load.mock.calls.at(-1);
      expect(Math.abs(forward.length - 4000)).toBeLessThanOrEqual(1);
      expectExactReversal(forward, reverse);
      await waitExports();
      expect(encodeM4A.mock.calls.every(([arg]) => Math.abs(arg.channels[0].length - 4000) <= 1)).toBe(true);
    });

    it('keeps the effect sound and its files through clear and undo', async () => {
      await recordClip();
      controller.setEffect('speed', 2);
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(1));
      await waitExports();
      controller.share('reversed');
      const file = shareFiles.mock.calls[0][0];
      const { forward } = heard();

      controller.clearRecording();
      expect(controller.getDuration()).toBe(0);
      shareFiles.mockClear();
      store.getState().toast.action();

      expect(store.getState().phase).toBe('ready');
      expect(player.load.mock.calls.at(-1)[0]).toBe(forward);
      expect(controller.getDuration()).toBeCloseTo(forward.length / 8000, 6);
      controller.share('reversed');
      expect(shareFiles.mock.calls[0][0]).toBe(file);
    });

    it('does nothing when set to the current value', async () => {
      await recordClip();
      await waitExports();
      track.mockClear();
      renderEffectInWorker.mockClear();
      player.replace.mockClear();

      const state = store.getState();
      let updates = 0;
      const stop = store.subscribe(() => { updates += 1; });
      controller.setEffect('speed', 1);
      controller.setEffect('pitch', 1);
      expect(updates).toBe(0);
      expect(store.getState()).toBe(state);
      expect(store.getState().effect).toEqual({ speed: 1, pitch: 1 });
      expect(track).not.toHaveBeenCalled();
      expect(renderEffectInWorker).not.toHaveBeenCalled();
      expect(player.replace).not.toHaveBeenCalled();
      stop();

      controller.setEffect('speed', 2);
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(1));
      await flush();
      track.mockClear();
      renderEffectInWorker.mockClear();
      const lit = store.getState();
      let later = 0;
      const stopLit = store.subscribe(() => { later += 1; });
      controller.setEffect('speed', 2);
      expect(later).toBe(0);
      expect(store.getState()).toBe(lit);
      expect(store.getState().effect).toEqual({ speed: 2, pitch: 1 });
      expect(track).not.toHaveBeenCalled();
      expect(renderEffectInWorker).not.toHaveBeenCalled();
      stopLit();
      await waitExports();
    });

    it('sets speed to 1/2 directly from normal without a 2x render', async () => {
      await recordClip();
      await waitExports();
      renderEffectInWorker.mockClear();
      track.mockClear();

      controller.setEffect('speed', 0.5);
      expect(store.getState().effect).toEqual({ speed: 0.5, pitch: 1 });
      expect(track).toHaveBeenCalledWith('effect_changed', { speed: 0.5, pitch: 1 });
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(1));
      expect(renderEffectInWorker).toHaveBeenCalledTimes(1);
      expect(renderEffectInWorker.mock.calls[0][0].effect).toEqual({ speed: 0.5, pitch: 1 });
      expect(renderEffectInWorker.mock.calls.some(([arg]) => arg.effect.speed === 2)).toBe(false);
      const { forward, reverse } = heard();
      expect(forward.length).toBe(16000);
      expectExactReversal(forward, reverse);
      await waitExports();
    });

    it('switches speed from 2 to 1/2 directly', async () => {
      await recordClip();
      await waitExports();
      controller.setEffect('speed', 2);
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(1));
      controller.setEffect('speed', 0.5);
      expect(store.getState().effect).toEqual({ speed: 0.5, pitch: 1 });
      expect(track).toHaveBeenCalledWith('effect_changed', { speed: 0.5, pitch: 1 });
      await vi.waitFor(() => expect(player.replace).toHaveBeenCalledTimes(2));
      expect(renderEffectInWorker.mock.calls.map(([arg]) => arg.effect)).toEqual([
        { speed: 2, pitch: 1 },
        { speed: 0.5, pitch: 1 },
      ]);
      const { forward, reverse } = heard();
      expect(forward.length).toBe(16000);
      expectExactReversal(forward, reverse);
      await waitExports();
    });

    it('ignores setEffect when the phase is not ready', async () => {
      controller.setEffect('speed', 2);
      controller.setEffect('pitch', 0.5);
      expect(store.getState().effect).toEqual({ speed: 1, pitch: 1 });
      expect(store.getState().phase).toBe('empty');
      expect(track).not.toHaveBeenCalled();
      expect(renderEffectInWorker).not.toHaveBeenCalled();

      controller.toggleRecord();
      await vi.waitFor(() => expect(store.getState().phase).toBe('recording'));
      track.mockClear();
      controller.setEffect('speed', 0.5);
      controller.setEffect('pitch', 2);
      expect(store.getState().effect).toEqual({ speed: 1, pitch: 1 });
      expect(track).not.toHaveBeenCalled();
      expect(renderEffectInWorker).not.toHaveBeenCalled();
      expect(player.replace).not.toHaveBeenCalled();
    });

    it('updates only the store while previewing', () => {
      setPreviewModel({ getDuration: () => 1 });
      const before = store.getState();
      controller.setEffect('speed', 1);
      expect(store.getState()).toBe(before);

      controller.setEffect('pitch', 0.5);
      expect(store.getState().effect).toEqual({ speed: 1, pitch: 0.5 });
      expect(store.getState()).not.toBe(before);
      const next = store.getState();
      controller.setEffect('pitch', 0.5);
      expect(store.getState()).toBe(next);
      expect(track).not.toHaveBeenCalled();
      expect(renderEffectInWorker).not.toHaveBeenCalled();
      expect(player.replace).not.toHaveBeenCalled();
      setPreviewModel(null);
    });
  });
});
