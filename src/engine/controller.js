import { getContext, onContextInterrupted, unlock } from '../audio/context.js';
import {
  decodeToBuffer,
  downmixToStereo,
  limitBuffer,
  resampleIfNeeded,
  validateRecording,
} from '../audio/decode.js';
import { encodeM4A, m4aFile } from '../audio/m4a.js';
import { computePeaks } from '../audio/peaks.js';
import { createPlayer } from '../audio/player.js';
import { clear as clearPersisted, load as loadPersisted, save as savePersisted } from '../audio/persist.js';
import { createRecorder } from '../audio/recorder.js';
import { reverseAudioBuffer } from '../audio/reverse.js';
import { encodeWav } from '../audio/wav.js';
import { grant, revoke, track } from '../lib/analytics.js';
import { exportFilename } from '../lib/filenames.js';
import * as haptics from '../lib/haptics.js';
import { canShareFiles, downloadBlob, shareFiles } from '../lib/share.js';
import { applyThemePreference, store } from './store.js';

/** Fired after seek / pause / stop so paused timers and waveforms can refresh. */
export const TRANSPORT_EVENT = 'fliprec:transport';

const MAX_SECONDS = 120;
const PEAK_BUCKETS = 2048;
const IMPORT_LIMIT_SECONDS = 300;
const IMPORT_LIMIT_BYTES = 200 * 1024 * 1024;
const EMPTY_PEAKS = [];
const START_ERRORS = ['mic-denied', 'mic-missing', 'unsupported', 'record-failed'];

let preview = null;
let phase = 'empty';
let sessionId = 0;
let toastSeq = 0;
let undoToken = 0;
let exportRun = 0;
let exportSession = -1;
let cancelPromise = null;
let persistTail = Promise.resolve();
// Frozen take length shown by the timer while a stopped recording is decoded.
let processingElapsed = 0;

const buffers = { forward: null, reverse: null };
const peaks = { forward: null, reverse: null };
const files = { reversed: null, original: null };
let sourceBlob = null;
let sourceMime = '';
let exportAbort = null;
let undoBackup = null;

const recorder = createRecorder({
  getContext,
  maxSeconds: MAX_SECONDS,
  onAutoStop: () => finishRecording('limit'),
  onInterrupted: () => finishRecording('interruption'),
});

const player = createPlayer(getContext);

player.onChange((playback) => {
  if (preview) return;
  const current = store.getState().playback;
  if (current.state !== playback.state || current.direction !== playback.direction) {
    store.setState({
      playback: { state: playback.state, direction: playback.direction },
    });
  }
  if (playback.state !== 'playing') notifyTransport();
});

onContextInterrupted(() => {
  if (preview) return;
  pauseIfPlaying();
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || preview) return;
    if (phase === 'requesting') {
      cancelStart(sessionId);
      return;
    }
    if (phase === 'recording') {
      finishRecording('interruption');
      return;
    }
    if (phase === 'ready') pauseIfPlaying();
  });
}

/**
 * Dev-only hook used by src/dev/preview.js. While a model is set, per-frame
 * getters delegate to it and transport actions stay out of the real engine.
 */
export function setPreviewModel(model) {
  preview = model || null;
}

function notifyTransport() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(TRANSPORT_EVENT));
}

function showToast(message, options = {}) {
  toastSeq += 1;
  const toast = { id: toastSeq, message };
  if (options.actionLabel) toast.actionLabel = options.actionLabel;
  if (typeof options.action === 'function') toast.action = options.action;
  store.setState({ toast });
}

function enqueuePersist(task) {
  persistTail = persistTail.then(() => task()).then(() => undefined, () => undefined);
}

function bufferDuration(buffer) {
  if (!buffer) return 0;
  if (typeof buffer.duration === 'number' && Number.isFinite(buffer.duration)) return buffer.duration;
  if (buffer.sampleRate > 0) return buffer.length / buffer.sampleRate;
  return 0;
}

function durationBucket(seconds) {
  if (seconds < 5) return '<5s';
  if (seconds < 15) return '5-15s';
  if (seconds < 30) return '15-30s';
  if (seconds < 60) return '30-60s';
  return '60-120s';
}

function readChannels(buffer) {
  const channels = [];
  const count = buffer && buffer.numberOfChannels ? buffer.numberOfChannels : 0;
  for (let i = 0; i < count; i += 1) channels.push(buffer.getChannelData(i));
  return channels;
}

function copyChannels(buffer) {
  // The worker transfers each ArrayBuffer. Copies keep the playback buffers intact.
  return readChannels(buffer).map((channel) => channel.slice());
}

function variantKey(variant) {
  return variant === 'original' ? 'original' : 'reversed';
}

function pauseIfPlaying() {
  try {
    if (player.getState().state === 'playing') player.pause();
  } catch {
    /* context already gone */
  }
}

function setExportStatus(variant, status) {
  const current = store.getState().exports;
  if (!current[variant] || current[variant].status === status) return;
  store.setState({
    exports: {
      reversed: variant === 'reversed' ? { status } : current.reversed,
      original: variant === 'original' ? { status } : current.original,
    },
  });
}

function restoreIdle(id, message) {
  if (id !== sessionId) return;
  const recording = store.getState().recording;
  phase = recording ? 'ready' : 'empty';
  store.setState({ phase });
  if (message) showToast(message);
  if (recording) ensureExports();
}

function failStart(id, error) {
  if (id !== sessionId) return;
  const kind = error && error.kind;
  if (kind === 'busy') {
    restoreIdle(id);
    return;
  }
  const recording = store.getState().recording;
  phase = recording ? 'ready' : 'empty';
  store.setState({
    phase,
    error: { kind: START_ERRORS.includes(kind) ? kind : 'record-failed' },
  });
  if (recording) ensureExports();
}

function onStarted(id, result) {
  if (id !== sessionId) {
    if (phase !== 'recording' && phase !== 'processing') {
      try { recorder.cancel(); } catch { /* already idle */ }
    }
    return;
  }
  if (result && result.cancelled) {
    if (phase === 'requesting') restoreIdle(id);
    return;
  }
  if (phase !== 'requesting') {
    try { recorder.cancel(); } catch { /* already idle */ }
    return;
  }
  phase = 'recording';
  store.setState({ phase: 'recording' });
  track('recording_started');
  haptics.tap();
}

function startRecording() {
  unlock();
  try { player.stop(); } catch { /* nothing loaded yet */ }
  const id = ++sessionId;
  phase = 'requesting';
  store.setState({ phase: 'requesting', error: null });
  let pending;
  try {
    pending = recorder.start();
  } catch (error) {
    failStart(id, error);
    return;
  }
  Promise.resolve(pending).then(
    (result) => onStarted(id, result),
    (error) => failStart(id, error),
  );
}

function cancelStart(id) {
  if (id !== sessionId || phase !== 'requesting' || cancelPromise) return;
  let pending;
  try {
    pending = recorder.stop();
  } catch (error) {
    pending = Promise.reject(error);
  }
  cancelPromise = Promise.resolve(pending).then(() => {
    cancelPromise = null;
    if (id !== sessionId || phase !== 'requesting') return;
    // stop() during the permission prompt resolves an empty cancelled capture.
    restoreIdle(id);
  }, () => {
    cancelPromise = null;
    if (id !== sessionId || phase !== 'requesting') return;
    restoreIdle(id);
  });
}

function finishRecording(reason) {
  if (phase !== 'recording') return;
  const id = sessionId;
  try { processingElapsed = recorder.getElapsed(); } catch { processingElapsed = 0; }
  phase = 'processing';
  store.setState({ phase: 'processing' });
  if (reason === 'manual') haptics.tap();
  if (reason === 'limit') showToast('2-minute limit reached');
  if (reason === 'interruption') showToast('Recording stopped when FlipRec went to the background');
  void consumeStop(id);
}

async function consumeStop(id) {
  let result;
  try {
    result = await recorder.stop();
  } catch {
    restoreIdle(id, "Couldn't process the recording");
    return;
  }
  if (id !== sessionId) return;
  if (result && result.cancelled) {
    restoreIdle(id);
    return;
  }
  if (!result?.blob || result.blob.size === 0) {
    restoreIdle(id, 'Nothing was recorded. Try again.');
    return;
  }
  try {
    const bytes = await result.blob.arrayBuffer();
    if (id !== sessionId) return;
    const ctx = getContext();
    let buffer = await decodeToBuffer(ctx, bytes);
    if (id !== sessionId) return;
    buffer = await resampleIfNeeded(buffer);
    if (id !== sessionId) return;
    buffer = downmixToStereo(ctx, buffer);
    if (!validateRecording(buffer).ok) {
      restoreIdle(id, 'Nothing was recorded. Try again.');
      return;
    }
    if (id !== sessionId) return;
    const adopted = adopt({
      id,
      buffer,
      sourceBlob: result.blob,
      mimeType: result.mimeType || result.blob.type || '',
      source: 'mic',
    });
    if (!adopted || id !== sessionId) return;
    track('recording_completed', { duration_bucket: durationBucket(bufferDuration(buffer)) });
  } catch {
    restoreIdle(id, "Couldn't process the recording");
  }
}

function adopt(input) {
  if (input.id !== sessionId) return false;
  const ctx = getContext();
  const forward = input.buffer;
  const reverse = reverseAudioBuffer(ctx, forward);
  const nextPeaks = {
    forward: computePeaks(readChannels(forward), PEAK_BUCKETS),
    reverse: computePeaks(readChannels(reverse), PEAK_BUCKETS),
  };
  if (exportAbort) exportAbort.abort();
  buffers.forward = forward;
  buffers.reverse = reverse;
  peaks.forward = nextPeaks.forward;
  peaks.reverse = nextPeaks.reverse;
  files.reversed = null;
  files.original = null;
  sourceBlob = input.sourceBlob;
  sourceMime = input.mimeType || '';
  try { player.load(forward, reverse); } catch { /* context unavailable */ }
  const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
  phase = 'ready';
  store.setState({
    phase: 'ready',
    recording: {
      id: input.id,
      duration: bufferDuration(forward),
      sampleRate: forward.sampleRate,
      channels: forward.numberOfChannels,
      createdAt,
      source: input.source,
    },
    playback: { state: 'stopped', direction: 'forward' },
    exports: {
      reversed: { status: 'encoding' },
      original: { status: 'encoding' },
    },
    error: null,
  });
  enqueuePersist(() => savePersisted({
    blob: sourceBlob,
    mimeType: sourceMime,
    createdAt,
    source: input.source,
  }));
  void runExports(input.id);
  return true;
}

function ensureExports() {
  if (!buffers.forward || !buffers.reverse || !store.getState().recording) return;
  const exp = store.getState().exports;
  const reversedReady = exp.reversed.status === 'ready' && files.reversed;
  const originalReady = exp.original.status === 'ready' && files.original;
  if (reversedReady && originalReady) return;
  if (exportSession === sessionId
    && (exp.reversed.status === 'encoding' || exp.original.status === 'encoding')) {
    return;
  }
  store.setState({
    exports: {
      reversed: reversedReady ? exp.reversed : { status: 'encoding' },
      original: originalReady ? exp.original : { status: 'encoding' },
    },
  });
  void runExports(sessionId);
}

async function runExports(id) {
  const run = ++exportRun;
  exportSession = id;
  if (exportAbort) exportAbort.abort();
  const active = new AbortController();
  exportAbort = active;
  const { signal } = active;
  const createdAt = store.getState().recording?.createdAt ?? Date.now();
  const jobs = [
    ['reversed', () => buffers.reverse],
    ['original', () => buffers.forward],
  ];
  try {
    for (let i = 0; i < jobs.length; i += 1) {
      const variant = jobs[i][0];
      if (run !== exportRun || id !== sessionId || signal.aborted) return;
      if (files[variant] && store.getState().exports[variant].status === 'ready') continue;
      const buffer = jobs[i][1]();
      if (!buffer) {
        setExportStatus(variant, 'error');
        continue;
      }
      try {
        const encoded = await encodeM4A({
          channels: copyChannels(buffer),
          sampleRate: buffer.sampleRate,
          signal,
        });
        if (run !== exportRun || id !== sessionId || signal.aborted) return;
        if (!encoded?.buffer) throw new Error('M4A encoding failed');
        files[variant] = m4aFile(
          encoded.buffer,
          exportFilename(variant, new Date(createdAt), 'm4a'),
        );
        setExportStatus(variant, 'ready');
      } catch (error) {
        if (run !== exportRun || id !== sessionId || signal.aborted) return;
        if (error && error.name === 'AbortError') return;
        setExportStatus(variant, 'error');
      }
    }
  } catch {
    /* a variant status was already recorded */
  }
}

function toggleRecord() {
  if (preview) return;
  if (phase === 'recording') {
    finishRecording('manual');
    return;
  }
  if (phase === 'empty' || phase === 'ready') startRecording();
}

function togglePlay(direction) {
  if (preview || phase !== 'ready') return;
  unlock();
  const dir = direction === 'reverse' ? 'reverse' : 'forward';
  let current;
  try {
    current = player.getState();
  } catch {
    return;
  }
  haptics.tap();
  if (current.state === 'playing' && current.direction === dir) {
    player.pause();
    return;
  }
  if (current.state === 'paused' && current.direction === dir) {
    player.resume();
    return;
  }
  player.play(dir, 0);
  track(dir === 'forward' ? 'played_forward' : 'played_reverse');
}

function seek(fraction) {
  const value = Number(fraction);
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  if (preview) {
    if (typeof preview.seek === 'function') preview.seek(clamped);
    notifyTransport();
    return;
  }
  if (phase === 'ready') {
    try {
      player.seek(clamped * bufferDuration(buffers.forward));
    } catch {
      /* no buffer */
    }
  }
  notifyTransport();
}

function share(variant = 'reversed') {
  if (preview) return undefined;
  const key = variantKey(variant);
  const file = files[key];
  const status = store.getState().exports[key]?.status;
  if (!file || status !== 'ready') {
    showToast(status === 'error' ? "Couldn't prepare audio" : 'Preparing audio...');
    return undefined;
  }
  track('share_initiated', { variant: key });
  if (!canShareFiles(file)) {
    downloadBlob(file, file.name);
    showToast("Sharing isn't available here, so the file was saved instead");
    return undefined;
  }
  let pending;
  try {
    pending = shareFiles(file);
  } catch (error) {
    failShare(error, file);
    return undefined;
  }
  Promise.resolve(pending).then((result) => {
    if (result === 'shared') track('share_completed');
    else if (result === 'cancelled') track('share_cancelled');
    else {
      downloadBlob(file, file.name);
      showToast("Sharing isn't available here, so the file was saved instead");
    }
  }, (error) => failShare(error, file));
  return undefined;
}

function failShare(error, file) {
  if (error && error.kind === 'activation') {
    showToast('Tap Share again');
    return;
  }
  downloadBlob(file, file.name);
  showToast("Sharing isn't available here, so the file was saved instead");
}

function download(variant, format = 'm4a') {
  if (preview) return;
  const key = variantKey(variant);
  if (format === 'wav') {
    const buffer = key === 'original' ? buffers.forward : buffers.reverse;
    if (!buffer) {
      showToast('Preparing audio...');
      return;
    }
    const wav = encodeWav(copyChannels(buffer), buffer.sampleRate);
    const createdAt = store.getState().recording?.createdAt ?? Date.now();
    downloadBlob(
      new Blob([wav], { type: 'audio/wav' }),
      exportFilename(key, new Date(createdAt), 'wav'),
    );
    track(`download_${key}`);
    return;
  }
  const file = files[key];
  const status = store.getState().exports[key]?.status;
  if (!file || status !== 'ready') {
    showToast(status === 'error' ? "Couldn't prepare audio" : 'Preparing audio...');
    return;
  }
  downloadBlob(file, file.name);
  track(`download_${key}`);
}

function importFile(file) {
  if (preview) return;
  if (phase !== 'empty' && phase !== 'ready') return;
  if (!file) return;
  if (file.size > IMPORT_LIMIT_BYTES) {
    showToast('That file is too large');
    return;
  }
  unlock();
  try { player.stop(); } catch { /* ignore */ }
  const id = ++sessionId;
  processingElapsed = 0;
  phase = 'processing';
  store.setState({ phase: 'processing', error: null });
  void consumeImport(id, file);
}

async function consumeImport(id, file) {
  try {
    const bytes = await file.arrayBuffer();
    if (id !== sessionId) return;
    const ctx = getContext();
    let buffer = await decodeToBuffer(ctx, bytes);
    if (id !== sessionId) return;
    const trimmed = buffer.length > Math.floor(IMPORT_LIMIT_SECONDS * buffer.sampleRate);
    buffer = limitBuffer(ctx, buffer, IMPORT_LIMIT_SECONDS);
    if (id !== sessionId) return;
    buffer = await resampleIfNeeded(buffer);
    if (id !== sessionId) return;
    buffer = downmixToStereo(ctx, buffer);
    if (!validateRecording(buffer).ok) throw new Error('invalid');
    if (id !== sessionId) return;
    const adopted = adopt({
      id,
      buffer,
      sourceBlob: file,
      mimeType: file.type || '',
      source: 'import',
    });
    if (!adopted || id !== sessionId) return;
    if (trimmed) showToast('Imported the first 5 minutes');
    track('audio_imported');
  } catch {
    restoreIdle(id, "That file couldn't be opened as audio");
  }
}

function armUndoWindow() {
  undoToken += 1;
  const token = undoToken;
  const handle = setTimeout(() => {
    if (token === undoToken) undoBackup = null;
  }, 5000);
  if (handle && typeof handle.unref === 'function') handle.unref();
}

function clearRecording() {
  if (preview) return;
  const recording = store.getState().recording;
  const active = phase !== 'empty' || recording || buffers.forward || sourceBlob;
  if (!active) return;

  if (recording) {
    undoBackup = {
      buffers: { forward: buffers.forward, reverse: buffers.reverse },
      peaks: { forward: peaks.forward, reverse: peaks.reverse },
      files: { reversed: files.reversed, original: files.original },
      recording,
      sourceBlob,
      sourceMime,
      exports: store.getState().exports,
    };
  } else {
    undoBackup = null;
  }

  sessionId += 1;
  if (exportAbort) exportAbort.abort();
  exportAbort = null;
  try { recorder.cancel(); } catch { /* already idle */ }
  try { player.stop(); } catch { /* ignore */ }
  buffers.forward = null;
  buffers.reverse = null;
  peaks.forward = null;
  peaks.reverse = null;
  files.reversed = null;
  files.original = null;
  const hadBlob = sourceBlob;
  sourceBlob = null;
  sourceMime = '';
  try { player.load(null, null); } catch { /* ignore */ }
  phase = 'empty';
  store.setState({
    phase: 'empty',
    recording: null,
    playback: { state: 'stopped', direction: 'forward' },
    exports: {
      reversed: { status: 'idle' },
      original: { status: 'idle' },
    },
    error: null,
    sheetOpen: false,
  });

  if (recording) {
    armUndoWindow();
    enqueuePersist(() => clearPersisted());
    showToast('Recording deleted', { actionLabel: 'Undo', action: undoClear });
  } else if (hadBlob) {
    enqueuePersist(() => clearPersisted());
  }
}

function undoClear() {
  if (preview) return;
  const backup = undoBackup;
  undoToken += 1;
  undoBackup = null;
  if (!backup?.recording || phase !== 'empty') return;
  buffers.forward = backup.buffers.forward;
  buffers.reverse = backup.buffers.reverse;
  peaks.forward = backup.peaks.forward;
  peaks.reverse = backup.peaks.reverse;
  files.reversed = backup.files.reversed;
  files.original = backup.files.original;
  sourceBlob = backup.sourceBlob;
  sourceMime = backup.sourceMime || '';
  try { player.load(buffers.forward, buffers.reverse); } catch { /* ignore */ }
  phase = 'ready';
  const exp = backup.exports || {
    reversed: { status: 'idle' },
    original: { status: 'idle' },
  };
  store.setState({
    phase: 'ready',
    recording: backup.recording,
    playback: { state: 'stopped', direction: 'forward' },
    exports: exp,
    error: null,
    toast: null,
  });
  if (sourceBlob) {
    enqueuePersist(() => savePersisted({
      blob: sourceBlob,
      mimeType: sourceMime,
      createdAt: backup.recording.createdAt,
      source: backup.recording.source,
    }));
  }
  const reversedReady = exp.reversed?.status === 'ready' && files.reversed;
  const originalReady = exp.original?.status === 'ready' && files.original;
  if (!reversedReady || !originalReady) {
    store.setState({
      exports: {
        reversed: reversedReady ? exp.reversed : { status: 'encoding' },
        original: originalReady ? exp.original : { status: 'encoding' },
      },
    });
    void runExports(sessionId);
  }
}

function setTheme(next) {
  if (next !== 'system' && next !== 'dark' && next !== 'light') return;
  applyThemePreference(next);
  store.setState({ theme: next });
}

function setConsent(granted) {
  store.setState({ consent: granted ? 'granted' : 'denied' });
  if (granted) grant();
  else revoke();
}

function openSheet() {
  store.setState({ sheetOpen: true });
}

function closeSheet() {
  store.setState({ sheetOpen: false });
}

function dismissError() {
  store.setState({ error: null });
}

function dismissToast() {
  store.setState({ toast: null });
}

async function restore() {
  if (preview || phase !== 'empty') return;
  const seen = sessionId;
  try {
    const record = await loadPersisted();
    if (!record?.blob) return;
    if (seen !== sessionId || phase !== 'empty') return;
    const ctx = getContext();
    const bytes = await record.blob.arrayBuffer();
    if (seen !== sessionId || phase !== 'empty') return;
    let buffer = await decodeToBuffer(ctx, bytes);
    if (seen !== sessionId || phase !== 'empty') return;
    buffer = await resampleIfNeeded(buffer);
    if (seen !== sessionId || phase !== 'empty') return;
    buffer = downmixToStereo(ctx, buffer);
    if (!validateRecording(buffer).ok) return;
    if (seen !== sessionId || phase !== 'empty') return;
    adopt({
      id: seen,
      buffer,
      sourceBlob: record.blob,
      mimeType: record.mimeType || record.blob.type || '',
      source: record.source === 'import' ? 'import' : 'mic',
      createdAt: record.createdAt,
    });
  } catch {
    /* a missing or unreadable recording stays on the empty screen */
  }
}

function getLevel() {
  if (preview && typeof preview.getLevel === 'function') return preview.getLevel();
  if (phase !== 'recording') return 0;
  try { return recorder.getLevel(); } catch { return 0; }
}

function getElapsed() {
  if (preview && typeof preview.getElapsed === 'function') return preview.getElapsed();
  if (phase === 'processing') return processingElapsed;
  if (phase !== 'recording') return 0;
  try { return recorder.getElapsed(); } catch { return 0; }
}

function getPosition() {
  if (preview && typeof preview.getPosition === 'function') return preview.getPosition();
  try { return player.getPosition(); } catch { return 0; }
}

function getDuration() {
  if (preview && typeof preview.getDuration === 'function') return preview.getDuration();
  return bufferDuration(buffers.forward);
}

function getPeaks(direction) {
  if (preview && typeof preview.getPeaks === 'function') {
    return preview.getPeaks(direction) || EMPTY_PEAKS;
  }
  const cached = direction === 'reverse' ? peaks.reverse : peaks.forward;
  return cached || EMPTY_PEAKS;
}

function getLevelHistory(count) {
  if (preview && typeof preview.getLevelHistory === 'function') {
    return preview.getLevelHistory(count);
  }
  return null;
}

export const controller = {
  toggleRecord,
  togglePlay,
  seek,
  share,
  download,
  importFile,
  clearRecording,
  undoClear,
  setTheme,
  setConsent,
  openSheet,
  closeSheet,
  dismissError,
  dismissToast,
  restore,
  getLevel,
  getElapsed,
  getPosition,
  getDuration,
  getPeaks,
  getLevelHistory,
  maxSeconds: MAX_SECONDS,
};
