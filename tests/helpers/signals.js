import { encodeWav } from '../../src/audio/wav.js';

/**
 * Linear chirp. Phase = 2π (f0 t + (f1 − f0) t² / (2T)).
 * @param {number} frameCount
 * @param {number} sampleRate
 * @param {number} f0
 * @param {number} f1
 * @param {number} amplitude
 */
export function linearChirp(frameCount, sampleRate, f0, f1, amplitude) {
  const out = new Float32Array(frameCount);
  const duration = frameCount / sampleRate;
  for (let i = 0; i < frameCount; i += 1) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * duration)) * t * t);
    out[i] = amplitude * Math.sin(phase);
  }
  return out;
}

/**
 * @param {number} frameCount
 * @param {number} sampleRate
 * @param {number} frequency
 * @param {number} amplitude
 */
export function sine(frameCount, sampleRate, frequency, amplitude) {
  const out = new Float32Array(frameCount);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < frameCount; i += 1) out[i] = amplitude * Math.sin(omega * i);
  return out;
}

/** @param {Float32Array} channel */
export function reverseSamples(channel) {
  const out = new Float32Array(channel.length);
  for (let i = 0; i < channel.length; i += 1) out[i] = channel[channel.length - 1 - i];
  return out;
}

/**
 * 3.0 s, 48 kHz, stereo. Left is a 300 to 3000 Hz chirp, right a 660 Hz sine.
 */
export function createExportFixture() {
  const sampleRate = 48000;
  const seconds = 3;
  const frames = sampleRate * seconds;
  const left = linearChirp(frames, sampleRate, 300, 3000, 0.5);
  const right = sine(frames, sampleRate, 660, 0.3);
  const bytes = Buffer.from(encodeWav([left, right], sampleRate));
  return { sampleRate, seconds, left, right, bytes };
}

/** Short audible stereo clip for share, consent, and offline checks. */
export function makeToneWav(seconds = 0.8) {
  const sampleRate = 48000;
  const frames = Math.round(seconds * sampleRate);
  const left = sine(frames, sampleRate, 440, 0.4);
  const right = sine(frames, sampleRate, 880, 0.2);
  return Buffer.from(encodeWav([left, right], sampleRate));
}

function correlationAt(reference, candidate, lag) {
  const refLen = reference.length;
  const start = Math.max(0, -lag);
  const end = Math.min(refLen, candidate.length - lag);
  if (end - start < refLen * 0.9) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let energyRef = 0;
  let energyCandidate = 0;
  for (let i = start; i < end; i += 1) {
    const a = reference[i];
    const b = candidate[i + lag];
    dot += a * b;
    energyRef += a * a;
    energyCandidate += b * b;
  }
  const denom = Math.sqrt(energyRef * energyCandidate);
  if (!(denom > 0)) return Number.NEGATIVE_INFINITY;
  return dot / denom;
}

function decimate(input, factor) {
  const length = Math.floor(input.length / factor);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = input[i * factor];
  return out;
}

/**
 * Best normalized correlation inside ±maxLag.
 * A coarse decimated search finds the lag, then a full-rate window refines it.
 * Overlap must cover 90% of `reference`.
 * @param {Float32Array} reference
 * @param {Float32Array} candidate
 * @param {number} [maxLag]
 */
export function bestNormalizedCorrelation(reference, candidate, maxLag = 8192) {
  const factor = 8;
  const refSmall = decimate(reference, factor);
  const candSmall = decimate(candidate, factor);
  const coarseMax = Math.ceil(maxLag / factor);
  let bestSmall = Number.NEGATIVE_INFINITY;
  let bestSmallLag = 0;
  for (let lag = -coarseMax; lag <= coarseMax; lag += 1) {
    const score = correlationAt(refSmall, candSmall, lag);
    if (score > bestSmall) {
      bestSmall = score;
      bestSmallLag = lag;
    }
  }

  const center = bestSmallLag * factor;
  const from = Math.max(-maxLag, center - factor * 4);
  const to = Math.min(maxLag, center + factor * 4);
  let best = Number.NEGATIVE_INFINITY;
  for (let lag = from; lag <= to; lag += 1) {
    const score = correlationAt(reference, candidate, lag);
    if (score > best) best = score;
  }
  return best;
}
