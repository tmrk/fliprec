import { getContext } from './context.js';

// One key (C major pentatonic) so every cue sounds like part of the same toy.
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;
const E6 = 1318.51;
const G6 = 1567.98;

const ATTACK = 0.003;
const GLIDE = 0.015;
const TAIL = Math.log(1000);
const FADE = 0.004;
const PAD_MS = 60;
// [harmonic, level]. Upper partials die faster, like a soft mallet on a bar.
const PARTIALS = [[1, 1], [2, 0.18], [3, 0.05]];

// [frequency, start s, decay time constant s, peak, pitch ratio at onset]
const CUES = {
  tap: [[C6, 0, 0.011, 0.06]],
  play: [[E6, 0, 0.022, 0.09, 0.94]],
  pause: [[G5, 0, 0.018, 0.07, 1.06]],
  start: [[C6, 0, 0.03, 0.11], [G6, 0.07, 0.034, 0.11]],
  stop: [[G6, 0, 0.03, 0.1], [C6, 0.07, 0.036, 0.11]],
  error: [[E5, 0, 0.04, 0.09], [C5, 0.09, 0.05, 0.09]],
};

export const SFX_NAMES = [...Object.keys(CUES), 'reverse'];

let enabled = true;
const cache = new Map();

/** Mono samples for a cue. `reverse` is the `play` cue, sample-reversed. */
export function renderSfx(name, sampleRate) {
  if (name === 'reverse') return renderSfx('play', sampleRate).reverse();
  const notes = CUES[name];
  if (!notes || !(sampleRate > 0)) return new Float32Array(0);
  let seconds = 0;
  for (const [, start, tau] of notes) seconds = Math.max(seconds, start + ATTACK + tau * TAIL);
  const out = new Float32Array(Math.ceil(seconds * sampleRate));
  for (const [freq, start, tau, peak, glide = 1] of notes) {
    const offset = Math.round(start * sampleRate);
    for (const [harmonic, level] of PARTIALS) {
      let phase = 0;
      for (let i = offset; i < out.length; i += 1) {
        const t = (i - offset) / sampleRate;
        const env = t < ATTACK ? t / ATTACK : Math.exp(-(t - ATTACK) * harmonic / tau);
        phase += (2 * Math.PI * freq * harmonic * (1 + (glide - 1) * Math.exp(-t / GLIDE))) / sampleRate;
        out[i] += peak * level * env * Math.sin(phase);
      }
    }
  }
  const fade = Math.min(out.length, Math.round(FADE * sampleRate));
  for (let i = 1; i <= fade; i += 1) out[out.length - i] *= (i - 1) / fade;
  return out;
}

export function setSfxEnabled(value) {
  enabled = Boolean(value);
}

export function isSfxEnabled() {
  return enabled;
}

/**
 * Plays a cue now. Returns the performance.now() time by which it has left the
 * speaker (with a safety pad), or 0 when nothing was played.
 */
export function playSfx(name) {
  if (!enabled || !SFX_NAMES.includes(name)) return 0;
  if (typeof document !== 'undefined' && document.hidden) return 0;
  try {
    const ctx = getContext();
    if (ctx.state !== 'running') {
      // Outside a gesture a suspended context would hold the cue and play it after a later tap.
      if (ctx.state === 'closed' || globalThis.navigator?.userActivation?.isActive === false) return 0;
      const pending = ctx.resume?.();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    }
    let buffer = cache.get(name);
    if (!buffer || buffer.sampleRate !== ctx.sampleRate) {
      const samples = renderSfx(name, ctx.sampleRate);
      buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.getChannelData(0).set(samples);
      cache.set(name, buffer);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => source.disconnect();
    source.start();
    const latency = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    return performance.now() + (buffer.duration + latency) * 1000 + PAD_MS;
  } catch {
    return 0;
  }
}
