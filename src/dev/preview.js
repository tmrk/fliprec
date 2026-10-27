import { rmsToLevel } from '../audio/level.js';
import { controller, setPreviewModel } from '../engine/controller.js';
import { store } from '../engine/store.js';

const READY_DURATION = 12.3;

function speechRms(t) {
  const syllable = Math.sin(t * 8.2) ** 2;
  const gate = Math.sin(t * 2.6 + 0.3) > -0.15 ? 1 : 0.04;
  const flutter = 0.7 + 0.3 * Math.sin(t * 19.4);
  return Math.min(0.5, (0.015 + syllable * gate * 0.3) * flutter);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speechPeaks(count, seed) {
  const random = mulberry32(seed);
  const peaks = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const t = i / count;
    const syllable = Math.sin(t * Math.PI * 22) ** 2;
    const phrase = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * Math.PI * 4.5));
    const gate = Math.sin(t * Math.PI * 7.5 + 0.4) > -0.25 ? 1 : 0.06;
    peaks[i] = Math.min(1, syllable * phrase * gate * (0.45 + random() * 0.55));
  }
  return peaks;
}

const forwardPeaks = speechPeaks(320, 7);
const reversePeaks = forwardPeaks.slice().reverse();

const silent = {
  getElapsed: () => 0,
  getLevel: () => 0,
  getDuration: () => 0,
  getPosition: () => 0,
  getPeaks: () => [],
};

function liveModel(elapsed) {
  const origin = performance.now();
  const nowSeconds = () => elapsed + (performance.now() - origin) / 1000;
  return {
    getElapsed: () => elapsed,
    getLevel: () => rmsToLevel(speechRms(nowSeconds())),
    getLevelHistory(count) {
      const now = nowSeconds();
      const history = new Array(count);
      for (let i = 0; i < count; i += 1) {
        const t = now - (count - 1 - i) * 0.05;
        history[i] = t > 0.02 ? speechRms(t) : 0;
      }
      return history;
    },
    getDuration: () => 0,
    getPosition: () => 0,
    getPeaks: () => [],
  };
}

function clipModel(position, duration = READY_DURATION) {
  let pos = position;
  return {
    getElapsed: () => 0,
    getLevel: () => 0,
    getDuration: () => duration,
    getPosition: () => pos,
    getPeaks: (direction) => (direction === 'reverse' ? reversePeaks : forwardPeaks),
    seek(fraction) {
      pos = fraction * duration;
    },
  };
}

function recordingMeta(duration) {
  return {
    id: 'preview',
    duration,
    sampleRate: 48000,
    channels: 1,
    createdAt: 0,
    source: 'mic',
  };
}

const readyExports = {
  reversed: { status: 'ready' },
  original: { status: 'ready' },
};

function base(overrides) {
  return {
    phase: 'empty',
    playback: { state: 'stopped', direction: 'forward' },
    recording: null,
    exports: {
      reversed: { status: 'idle' },
      original: { status: 'idle' },
    },
    error: null,
    toast: null,
    sheetOpen: false,
    consent: 'granted',
    ...overrides,
  };
}

function readyState(playback, position) {
  return {
    state: base({
      phase: 'ready',
      playback,
      recording: recordingMeta(READY_DURATION),
      exports: readyExports,
    }),
    model: clipModel(position),
  };
}

const scenarios = {
  empty: {
    state: base(),
    model: silent,
  },
  recording: {
    state: base({ phase: 'recording' }),
    model: liveModel(7.4),
  },
  'recording-late': {
    state: base({ phase: 'recording' }),
    model: liveModel(112),
  },
  processing: {
    state: base({
      phase: 'processing',
      recording: recordingMeta(7.4),
    }),
    model: {
      ...silent,
      getDuration: () => 7.4,
      getPeaks: () => forwardPeaks,
    },
  },
  ready: readyState({ state: 'stopped', direction: 'forward' }, 0),
  'playing-forward': readyState({ state: 'playing', direction: 'forward' }, READY_DURATION * 0.35),
  'playing-reverse': readyState({ state: 'playing', direction: 'reverse' }, READY_DURATION * 0.6),
  paused: readyState({ state: 'paused', direction: 'forward' }, READY_DURATION * 0.42),
  encoding: {
    state: base({
      phase: 'ready',
      recording: recordingMeta(READY_DURATION),
      exports: {
        reversed: { status: 'encoding' },
        original: { status: 'idle' },
      },
    }),
    model: clipModel(0),
  },
  'mic-denied': {
    state: base({
      consent: 'granted',
      error: {
        kind: 'mic-denied',
        message: 'Allow microphone access for this site in your browser settings, then try again.',
      },
    }),
    model: silent,
  },
  toast: {
    state: base({
      phase: 'ready',
      recording: recordingMeta(READY_DURATION),
      exports: readyExports,
      toast: {
        id: 'preview-toast',
        message: 'Recording cleared',
        actionLabel: 'Undo',
        action() {
          controller.undoClear();
        },
      },
    }),
    model: clipModel(0),
  },
  consent: {
    state: base({
      consent: 'unset',
      analyticsAvailable: true,
    }),
    model: silent,
  },
  sheet: {
    state: base({
      phase: 'ready',
      recording: recordingMeta(READY_DURATION),
      exports: readyExports,
      sheetOpen: true,
      analyticsAvailable: true,
      consent: 'granted',
    }),
    model: clipModel(0),
  },
  pressed: {
    state: base({
      phase: 'ready',
      recording: recordingMeta(READY_DURATION),
      exports: readyExports,
    }),
    model: clipModel(0),
    pressed: true,
  },
};

function holdPressed(selectors) {
  const apply = () => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (!el.hasAttribute('data-pressed')) el.setAttribute('data-pressed', '');
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'data-pressed', 'disabled', 'aria-disabled'],
  });
}

export function installPreview() {
  const name = new URLSearchParams(window.location.search).get('preview');
  const scenario = scenarios[name];
  if (!scenario) return;
  const current = store.getState();
  store.setState({
    ...scenario.state,
    theme: current.theme,
    analyticsAvailable:
      scenario.state.analyticsAvailable === undefined
        ? current.analyticsAvailable
        : scenario.state.analyticsAvailable,
  });
  setPreviewModel(scenario.model);
  if (scenario.pressed) holdPressed(['.fr-record', '.fr-tile--reverse']);
}
