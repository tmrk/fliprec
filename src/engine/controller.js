import {
  getContext,
  markContextStalled,
  onContextInterrupted,
  setAudioSessionType,
  unlock,
} from '../audio/context.js';
import { isNeutralEffect, NEUTRAL_EFFECT, normalizeEffect } from '../audio/effect.js';
import { encodeM4A, m4aFile } from '../audio/m4a.js';
import { computePeaks } from '../audio/peaks.js';
import { createPlayer } from '../audio/player.js';
import { clear as clearPersisted, load as loadPersisted, save as savePersisted } from '../audio/persist.js';
import { createRecorder } from '../audio/recorder.js';
import { reverseAudioBuffer } from '../audio/reverse.js';
import { playSfx, setSfxEnabled } from '../audio/sfx.js';
import { encodeWav } from '../audio/wav.js';
import { grant, revoke, track } from '../lib/analytics.js';
import { visibleTimeout } from '../lib/deadline.js';
import { exportFilename } from '../lib/filenames.js';
import * as haptics from '../lib/haptics.js';
import { canShareFiles, downloadBlob, shareFiles } from '../lib/share.js';
import { applyThemePreference, store, writeSoundsPreference } from './store.js';

/** Fired after seek / pause / stop so paused timers and waveforms can refresh. */
export const TRANSPORT_EVENT = 'fliprec:transport';

const MAX_SECONDS = 120;
const PEAK_BUCKETS = 2048;
const IMPORT_LIMIT_SECONDS = 300;
const IMPORT_LIMIT_BYTES = 200 * 1024 * 1024;
const EMPTY_PEAKS = [];
const START_ERRORS = ['mic-denied', 'mic-missing', 'unsupported', 'record-failed'];
// Quiet period after the last Speed or Pitch tap before exports are rebuilt.
const EFFECT_EXPORT_DELAY_MS = 400;
// Taps on the record button while the microphone starts are ignored this long (double taps),
// then they cancel a start that is hanging on the permission prompt.
const START_CANCEL_GRACE_MS = 1000;
// Backstop for a take stuck in Processing. Every step has its own shorter deadline.
const PROCESSING_TIMEOUT_MS = 60000;

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
let requestingSince = 0;
let stopProcessingWatchdog = null;

// `buffers` is the take as recorded. `active` is what is heard, timed, sought and exported:
// the very same objects when the effect is neutral, else the take with speed and pitch applied.
const buffers = { forward: null, reverse: null };
const active = { forward: null, reverse: null };
let activeEffect = NEUTRAL_EFFECT;
let effectRun = 0;
let effectAbort = null;
let effectExportTimer = 0;
const peaks = { forward: null, reverse: null };
const files = { reversed: null, original: null };
let sourceBlob = null;
let sourceMime = '';
let exportAbort = null;
let undoBackup = null;

setSfxEnabled(store.getState().sounds);

const recorder = createRecorder({
  getContext,
  maxSeconds: MAX_SECONDS,
  onAutoStop: () => finishRecording('limit'),
  onInterrupted: () => finishRecording('interruption'),
});

const player = createPlayer(getContext, { onStall: onPlaybackStall });

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

// Interruptions pause cleanly. `replaced` arrives while the old clock is still readable.
onContextInterrupted(() => {
  if (preview) return;
  pauseIfPlaying();
});

function onPlaybackStall() {
  if (preview) return;
  markContextStalled();
  showToast('Audio paused. Tap again to continue.');
}

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

let decodeModule = null;

/** Decoding is only needed once there is audio, so it stays out of the entry chunk. */
function loadDecode() {
  if (!decodeModule) {
    decodeModule = import('../audio/decode.js').catch((error) => {
      decodeModule = null;
      throw error;
    });
  }
  return decodeModule;
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

function clearProcessingWatchdog() {
  if (stopProcessingWatchdog) stopProcessingWatchdog();
  stopProcessingWatchdog = null;
}

/** A take that never leaves Processing is dropped; the previous one stays. */
function armProcessingWatchdog(id) {
  clearProcessingWatchdog();
  stopProcessingWatchdog = visibleTimeout(() => {
    stopProcessingWatchdog = null;
    if (id !== sessionId || phase !== 'processing') return;
    sessionId += 1;
    cancelEffectWork();
    try { recorder.cancel(); } catch { /* already idle */ }
    playSfx('error');
    restoreIdle(sessionId, "Couldn't process the recording");
  }, PROCESSING_TIMEOUT_MS);
}

function restoreIdle(id, message) {
  if (id !== sessionId) return;
  clearProcessingWatchdog();
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
  playSfx('error');
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
  requestingSince = performance.now();
  store.setState({ phase: 'requesting', error: null });
  let pending;
  try {
    const cueEnd = playSfx('start');
    pending = recorder.start({ notBefore: cueEnd });
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
  armProcessingWatchdog(id);
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
    if (id === sessionId) playSfx('error');
    restoreIdle(id, "Couldn't process the recording");
    return;
  }
  if (id !== sessionId) return;
  if (result && result.cancelled) {
    restoreIdle(id);
    return;
  }
  if (!result?.blob || result.blob.size === 0) {
    playSfx('error');
    restoreIdle(id, 'Nothing was recorded. Try again.');
    return;
  }
  // Once the stop cue has played, later failures only toast so two cues never collide.
  playSfx('stop');
  try {
    const {
      decodeToBuffer, downmixToStereo, resampleIfNeeded, validateRecording,
    } = await loadDecode();
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
    const adopted = await adopt({
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

function sameEffect(a, b) {
  const x = normalizeEffect(a);
  const y = normalizeEffect(b);
  return x.speed === y.speed && x.pitch === y.pitch;
}

function toAudioBuffer(ctx, channels, sampleRate) {
  const length = channels.length ? channels[0].length : 0;
  const buffer = ctx.createBuffer(channels.length || 1, Math.max(1, length), sampleRate);
  for (let i = 0; i < channels.length; i += 1) buffer.copyToChannel(channels[i], i);
  return buffer;
}

/** Render `source` with `effect` off the main thread; resolves `{ forward, reverse }`. */
async function renderActive(source, effect, signal) {
  const { renderEffectInWorker } = await import('../audio/effects.js');
  const channels = await renderEffectInWorker({
    channels: copyChannels(source),
    sampleRate: source.sampleRate,
    effect,
    signal,
  });
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const ctx = getContext();
  const forward = toAudioBuffer(ctx, channels, source.sampleRate);
  return { forward, reverse: reverseAudioBuffer(ctx, forward) };
}

function clearEffectExportTimer() {
  if (effectExportTimer) clearTimeout(effectExportTimer);
  effectExportTimer = 0;
}

/** Drop any in-flight render and pending export rebuild. */
function cancelEffectWork() {
  effectRun += 1;
  if (effectAbort) effectAbort.abort();
  effectAbort = null;
  clearEffectExportTimer();
}

function invalidateExports() {
  if (exportAbort) exportAbort.abort();
  exportAbort = null;
  files.reversed = null;
  files.original = null;
  store.setState({
    exports: {
      reversed: { status: 'encoding' },
      original: { status: 'encoding' },
    },
  });
}

function scheduleEffectExports() {
  clearEffectExportTimer();
  effectExportTimer = setTimeout(() => {
    effectExportTimer = 0;
    // A recording in progress rebuilds exports itself when it ends or fails.
    if (phase !== 'ready' || !active.forward) return;
    void runExports(sessionId);
  }, EFFECT_EXPORT_DELAY_MS);
}

function setActive(forward, reverse, effect) {
  active.forward = forward;
  active.reverse = reverse;
  activeEffect = normalizeEffect(effect);
  try { player.replace(forward, reverse); } catch { /* context unavailable */ }
  notifyTransport();
}

function applyEffect() {
  cancelEffectWork();
  const run = effectRun;
  const effect = normalizeEffect(store.getState().effect);
  invalidateExports();
  if (isNeutralEffect(effect)) {
    setActive(buffers.forward, buffers.reverse, NEUTRAL_EFFECT);
    scheduleEffectExports();
    return;
  }
  const abort = new AbortController();
  effectAbort = abort;
  renderActive(buffers.forward, effect, abort.signal).then((next) => {
    if (run !== effectRun) return;
    effectAbort = null;
    setActive(next.forward, next.reverse, effect);
    invalidateExports();
    scheduleEffectExports();
  }, (error) => {
    if (run !== effectRun) return;
    effectAbort = null;
    if (error && error.name === 'AbortError') return;
    store.setState({ effect: { ...NEUTRAL_EFFECT } });
    setActive(buffers.forward, buffers.reverse, NEUTRAL_EFFECT);
    invalidateExports();
    showToast("Couldn't change the sound");
    scheduleEffectExports();
  });
}

/** Set Speed or Pitch to 1, 2 or 0.5. Repeating the current value does nothing. */
function setEffect(kind, value) {
  const key = kind === 'pitch' ? 'pitch' : 'speed';
  const current = normalizeEffect(store.getState().effect);
  const next = normalizeEffect({ ...current, [key]: value });
  if (sameEffect(current, next)) return;
  if (preview) {
    store.setState({ effect: next });
    return;
  }
  if (phase !== 'ready' || !buffers.forward) return;
  store.setState({ effect: next });
  track('effect_changed', { speed: next.speed, pitch: next.pitch });
  applyEffect();
}

/**
 * Make a decoded take current. With an effect on, the take is rendered first so it is never
 * heard without it; phase stays `processing` meanwhile. Resolves false when superseded.
 */
async function adopt(input) {
  if (input.id !== sessionId) return false;
  const ctx = getContext();
  const forward = input.buffer;
  const reverse = reverseAudioBuffer(ctx, forward);
  const nextPeaks = {
    forward: computePeaks(readChannels(forward), PEAK_BUCKETS),
    reverse: computePeaks(readChannels(reverse), PEAK_BUCKETS),
  };
  let effect = normalizeEffect(store.getState().effect);
  let heard = { forward, reverse };
  if (!isNeutralEffect(effect)) {
    cancelEffectWork();
    const run = effectRun;
    const abort = new AbortController();
    effectAbort = abort;
    try {
      heard = await renderActive(forward, effect, abort.signal);
    } catch (error) {
      if (run !== effectRun || input.id !== sessionId) return false;
      if (error && error.name === 'AbortError') return false;
      effect = NEUTRAL_EFFECT;
      heard = { forward, reverse };
      store.setState({ effect: { ...NEUTRAL_EFFECT } });
      showToast("Couldn't change the sound");
    }
    if (run !== effectRun || input.id !== sessionId) return false;
    effectAbort = null;
  }
  if (input.id !== sessionId) return false;
  clearProcessingWatchdog();
  cancelEffectWork();
  if (exportAbort) exportAbort.abort();
  buffers.forward = forward;
  buffers.reverse = reverse;
  active.forward = heard.forward;
  active.reverse = heard.reverse;
  activeEffect = effect;
  peaks.forward = nextPeaks.forward;
  peaks.reverse = nextPeaks.reverse;
  files.reversed = null;
  files.original = null;
  sourceBlob = input.sourceBlob;
  sourceMime = input.mimeType || '';
  try { player.load(active.forward, active.reverse); } catch { /* context unavailable */ }
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
  if (!active.forward || !active.reverse || !store.getState().recording) return;
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
  const runAbort = new AbortController();
  exportAbort = runAbort;
  const { signal } = runAbort;
  const createdAt = store.getState().recording?.createdAt ?? Date.now();
  const jobs = [
    ['reversed', () => active.reverse],
    ['original', () => active.forward],
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
  if (phase === 'requesting') {
    if (performance.now() - requestingSince >= START_CANCEL_GRACE_MS) cancelStart(sessionId);
    return;
  }
  if (phase === 'empty' || phase === 'ready') startRecording();
}

function togglePlay(direction) {
  if (preview || phase !== 'ready') return;
  const dir = direction === 'reverse' ? 'reverse' : 'forward';
  let current;
  try {
    current = player.getState();
  } catch {
    return;
  }
  haptics.tap();
  if (current.state === 'playing' && current.direction === dir) {
    playSfx('pause');
    player.pause();
    return;
  }
  // Without `playback`, iOS treats Web Audio as ambient and the ring/silent switch mutes it.
  setAudioSessionType('playback');
  // May swap a context that went stale in the background, which pauses playback first.
  unlock();
  try {
    current = player.getState();
  } catch {
    return;
  }
  playSfx(dir === 'reverse' ? 'reverse' : 'play');
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
      player.seek(clamped * bufferDuration(active.forward));
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
    notReady(status);
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

/** A failed export is rebuilt when someone asks for it again. */
function notReady(status) {
  if (status === 'error' && phase === 'ready') {
    showToast("Couldn't prepare audio. Trying again.");
    ensureExports();
    return;
  }
  showToast(status === 'error' ? "Couldn't prepare audio" : 'Preparing audio...');
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
    const buffer = key === 'original' ? active.forward : active.reverse;
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
    notReady(status);
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
  armProcessingWatchdog(id);
  void consumeImport(id, file);
}

async function consumeImport(id, file) {
  try {
    const {
      decodeToBuffer, downmixToStereo, limitBuffer, resampleIfNeeded, validateRecording,
    } = await loadDecode();
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
    const adopted = await adopt({
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
    if (id === sessionId) playSfx('error');
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
  const hasTake = phase !== 'empty' || recording || buffers.forward || sourceBlob;
  if (!hasTake) return;

  if (recording) {
    undoBackup = {
      buffers: { forward: buffers.forward, reverse: buffers.reverse },
      active: { forward: active.forward, reverse: active.reverse },
      activeEffect,
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
  clearProcessingWatchdog();
  cancelEffectWork();
  if (exportAbort) exportAbort.abort();
  exportAbort = null;
  try { recorder.cancel(); } catch { /* already idle */ }
  try { player.stop(); } catch { /* ignore */ }
  buffers.forward = null;
  buffers.reverse = null;
  active.forward = null;
  active.reverse = null;
  activeEffect = NEUTRAL_EFFECT;
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
  // The backup holds what was heard at the time; it only still fits if the effect is unchanged.
  const effectHolds = backup.active?.forward && sameEffect(backup.activeEffect, store.getState().effect);
  active.forward = effectHolds ? backup.active.forward : buffers.forward;
  active.reverse = effectHolds ? backup.active.reverse : buffers.reverse;
  activeEffect = effectHolds ? normalizeEffect(backup.activeEffect) : NEUTRAL_EFFECT;
  peaks.forward = backup.peaks.forward;
  peaks.reverse = backup.peaks.reverse;
  files.reversed = effectHolds ? backup.files.reversed : null;
  files.original = effectHolds ? backup.files.original : null;
  sourceBlob = backup.sourceBlob;
  sourceMime = backup.sourceMime || '';
  try { player.load(active.forward, active.reverse); } catch { /* ignore */ }
  phase = 'ready';
  const exp = (effectHolds && backup.exports) || {
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
  if (!effectHolds && !isNeutralEffect(store.getState().effect)) {
    applyEffect();
    return;
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

function setSounds(on) {
  const enabled = Boolean(on);
  writeSoundsPreference(enabled);
  store.setState({ sounds: enabled });
  setSfxEnabled(enabled);
  if (enabled) playSfx('tap');
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
    const {
      decodeToBuffer, downmixToStereo, resampleIfNeeded, validateRecording,
    } = await loadDecode();
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
    await adopt({
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
  return bufferDuration(active.forward);
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
  setEffect,
  seek,
  share,
  download,
  importFile,
  clearRecording,
  undoClear,
  setTheme,
  setSounds,
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
