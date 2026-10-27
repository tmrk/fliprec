import { setAudioSessionType } from './context.js';
import { rmsToLevel } from './level.js';
import { pickRecorderMimeType } from './mime.js';

const CONSTRAINTS = {
  audio: {
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const LEVEL_ATTACK = 0.35;

function errorWithKind(message, kind) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function mapMediaError(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return errorWithKind('Microphone permission was denied', 'mic-denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return errorWithKind('No microphone is available', 'mic-missing');
  }
  return errorWithKind('Recording failed', 'record-failed');
}

function canCapture() {
  return typeof MediaRecorder !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

function emptyResult(elapsed = 0) {
  return { blob: new Blob([], { type: '' }), mimeType: '', elapsed };
}

/**
 * Mic capture. States: idle, starting, recording, stopping, idle.
 * `stop`/`cancel` during the permission prompt resolves the pending start as
 * cancelled and releases the stream as soon as it arrives.
 */
export function createRecorder({
  getContext,
  maxSeconds = 120,
  onAutoStop,
  onInterrupted,
} = {}) {
  let state = 'idle';
  let stream = null;
  let sourceNode = null;
  let analyser = null;
  let sink = null;
  let mediaRecorder = null;
  let chunks = [];
  let chosenMime = '';
  let startedAt = 0;
  let frozenElapsed = null;
  let autoTimer = null;
  let levelScratch = null;
  let smoothedRms = 0;
  let cancelRequested = false;
  let startPromise = null;
  let visibilityHandler = null;
  let cleaning = false;
  let stopResolve = null;
  const trackCleanups = [];

  function notify(reason) {
    try {
      onInterrupted?.(reason);
    } catch (error) {
      console.warn(error);
    }
  }

  function clearAutoTimer() {
    if (autoTimer != null) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
  }

  function detachRecorder(recorder) {
    try {
      recorder.removeEventListener('dataavailable', onData);
      recorder.removeEventListener('error', onRecorderError);
    } catch (error) {
      console.warn(error);
    }
  }

  function onData(event) {
    if (event && event.data) chunks.push(event.data);
  }

  function onRecorderError() {
    if (state === 'recording') notify('error');
  }

  function onTrackEnded() {
    if (state === 'recording') notify('ended');
  }

  function onVisibility() {
    if (document.hidden && state === 'recording') notify('visibility');
  }

  function cleanup() {
    if (cleaning) return;
    cleaning = true;
    const resolvePending = stopResolve;
    stopResolve = null;
    try {
      state = 'idle';
      clearAutoTimer();
      for (const undo of trackCleanups.splice(0)) {
        try {
          undo();
        } catch (error) {
          console.warn(error);
        }
      }
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }
      const recorder = mediaRecorder;
      mediaRecorder = null;
      if (recorder) {
        detachRecorder(recorder);
        if (recorder.state === 'recording') {
          try {
            recorder.stop();
          } catch (error) {
            console.warn(error);
          }
        }
      }
      const live = stream;
      stream = null;
      if (live) {
        for (const track of live.getTracks()) {
          try {
            track.stop();
          } catch (error) {
            console.warn(error);
          }
        }
      }
      if (sourceNode) {
        try {
          sourceNode.disconnect();
        } catch (error) {
          console.warn(error);
        }
        sourceNode = null;
      }
      if (analyser) {
        try {
          analyser.disconnect();
        } catch (error) {
          console.warn(error);
        }
        analyser = null;
      }
      if (sink) {
        try {
          sink.disconnect();
        } catch (error) {
          console.warn(error);
        }
        sink = null;
      }
      chunks = [];
      levelScratch = null;
      setAudioSessionType('playback');
    } finally {
      cleaning = false;
    }
    if (resolvePending) resolvePending(emptyResult(frozenElapsed ?? 0));
  }

  function armAutoStop() {
    clearAutoTimer();
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (state !== 'recording') return;
      try {
        onAutoStop?.();
      } catch (error) {
        console.warn(error);
      }
    }, Math.max(0, maxSeconds) * 1000);
  }

  async function begin() {
    try {
      setAudioSessionType('play-and-record');
      if (!canCapture()) {
        throw errorWithKind('Recording is not supported in this browser', 'unsupported');
      }
      let live;
      try {
        live = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
      } catch (error) {
        throw mapMediaError(error);
      }
      if (cancelRequested || state !== 'starting') {
        stream = live;
        cleanup();
        state = 'idle';
        return { cancelled: true };
      }

      stream = live;
      const ctx = getContext();
      sourceNode = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      sourceNode.connect(analyser);
      // WebKit only processes nodes with a path to the destination; a muted sink keeps the
      // analyser live without monitoring the microphone audibly.
      sink = ctx.createGain();
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(ctx.destination);

      chosenMime = pickRecorderMimeType();
      const recorderOptions = { audioBitsPerSecond: 128000 };
      if (chosenMime) recorderOptions.mimeType = chosenMime;
      try {
        mediaRecorder = new MediaRecorder(stream, recorderOptions);
      } catch (error) {
        throw errorWithKind('Recording failed', 'record-failed');
      }
      mediaRecorder.addEventListener('dataavailable', onData);
      mediaRecorder.addEventListener('error', onRecorderError);
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', onTrackEnded);
        trackCleanups.push(() => track.removeEventListener('ended', onTrackEnded));
      }
      visibilityHandler = onVisibility;
      document.addEventListener('visibilitychange', visibilityHandler);

      // No timeslice: one complete file at stop() decodes most reliably (Safari's
      // timesliced MP4 fragments are a known decodeAudioData failure source).
      try {
        mediaRecorder.start();
      } catch (error) {
        throw errorWithKind('Recording failed', 'record-failed');
      }
      startedAt = performance.now();
      frozenElapsed = null;
      smoothedRms = 0;
      state = 'recording';
      armAutoStop();
      return undefined;
    } catch (error) {
      cleanup();
      state = 'idle';
      if (error && error.kind) throw error;
      throw mapMediaError(error);
    }
  }

  function start() {
    if (state !== 'idle') {
      return Promise.reject(errorWithKind('Recorder is busy', 'busy'));
    }
    state = 'starting';
    cancelRequested = false;
    chunks = [];
    startPromise = begin();
    return startPromise;
  }

  function stop() {
    if (state === 'starting') {
      cancelRequested = true;
      const pending = startPromise || Promise.resolve();
      return pending.then(() => emptyResult(), () => emptyResult());
    }
    if (state !== 'recording') {
      return Promise.resolve(emptyResult(frozenElapsed ?? 0));
    }

    const recorder = mediaRecorder;
    frozenElapsed = Math.max(0, (performance.now() - startedAt) / 1000);
    clearAutoTimer();
    state = 'stopping';

    return new Promise((resolve, reject) => {
      stopResolve = resolve;
      const finish = () => {
        if (stopResolve !== resolve) return;
        const mime = (recorder && recorder.mimeType) || chosenMime || '';
        const blob = new Blob(chunks, { type: mime });
        const elapsed = frozenElapsed ?? 0;
        stopResolve = null;
        cleanup();
        state = 'idle';
        resolve({ blob, mimeType: mime, elapsed });
      };
      try {
        if (!recorder || recorder.state === 'inactive') {
          finish();
          return;
        }
        recorder.addEventListener('stop', finish);
        recorder.stop();
      } catch (error) {
        console.warn(error);
        if (stopResolve === resolve) {
          stopResolve = null;
          cleanup();
          state = 'idle';
          reject(errorWithKind('Recording failed', 'record-failed'));
        }
      }
    });
  }

  function cancel() {
    if (state === 'starting') {
      cancelRequested = true;
      return;
    }
    if (state !== 'recording' && state !== 'stopping') return;
    cleanup();
    state = 'idle';
    frozenElapsed = null;
  }

  function getElapsed() {
    if (frozenElapsed != null) return frozenElapsed;
    if (state !== 'recording' && state !== 'stopping') return 0;
    return Math.max(0, (performance.now() - startedAt) / 1000);
  }

  function getLevel() {
    if (state !== 'recording' || !analyser) return 0;
    const size = analyser.fftSize || 1024;
    if (!levelScratch || levelScratch.length !== size) levelScratch = new Float32Array(size);
    analyser.getFloatTimeDomainData(levelScratch);
    let sum = 0;
    for (let i = 0; i < levelScratch.length; i += 1) {
      const sample = levelScratch[i];
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / levelScratch.length);
    smoothedRms += (rms - smoothedRms) * LEVEL_ATTACK;
    return rmsToLevel(smoothedRms);
  }

  return {
    start,
    stop,
    cancel,
    getLevel,
    getElapsed,
    cleanup,
    get state() {
      return state;
    },
  };
}
