/**
 * Speed and pitch effects (pure, no Web Audio).
 *
 * Speed works like tape: 2x is twice as fast and an octave higher. Pitch then shifts
 * that result without changing its length, so Speed 2x with Pitch 1/2x is fast at the
 * normal pitch. Every factor is a power of two, so resampling is a cascade of half-band
 * stages and the pitch shift is one WSOLA time stretch by exactly 2 or 1/2.
 */

import { normalizeEffect } from './effect.js';

// Half-band low-pass: cutoff at a quarter of the sample rate, Kaiser windowed.
// Odd taps only (even taps are zero apart from the centre, which is 0.5).
const HALF_TAPS = 16;
const HALF = (() => {
  const reach = 2 * HALF_TAPS - 1;
  const beta = 7.5;
  const i0 = (x) => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 40; k += 1) {
      term *= (x / (2 * k)) ** 2;
      sum += term;
      if (term < 1e-12 * sum) break;
    }
    return sum;
  };
  const taps = new Float64Array(HALF_TAPS);
  let total = 0;
  for (let j = 0; j < HALF_TAPS; j += 1) {
    const k = 2 * j + 1;
    const sinc = Math.sin((Math.PI * k) / 2) / ((Math.PI * k) / 2);
    const ratio = k / (reach + 1);
    const window = i0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0(beta);
    taps[j] = 0.5 * sinc * window;
    total += 2 * taps[j];
  }
  // Odd taps sum to 0.5 so DC passes at unity in both directions.
  for (let j = 0; j < HALF_TAPS; j += 1) taps[j] *= 0.5 / total;
  return taps;
})();

/** Half the samples (pitch up an octave), anti-aliased. */
export function decimate2(x) {
  const n = x.length;
  const out = new Float32Array(Math.ceil(n / 2));
  const edge = 2 * HALF_TAPS;
  for (let m = 0; m < out.length; m += 1) {
    const c = 2 * m;
    let acc = 0.5 * x[c];
    if (c >= edge && c + edge < n) {
      for (let j = 0; j < HALF_TAPS; j += 1) {
        const d = 2 * j + 1;
        acc += HALF[j] * (x[c - d] + x[c + d]);
      }
    } else {
      for (let j = 0; j < HALF_TAPS; j += 1) {
        const d = 2 * j + 1;
        const a = c - d >= 0 ? x[c - d] : 0;
        const b = c + d < n ? x[c + d] : 0;
        acc += HALF[j] * (a + b);
      }
    }
    out[m] = acc;
  }
  return out;
}

/** Double the samples (pitch down an octave), image-free. */
export function interpolate2(x) {
  const n = x.length;
  const out = new Float32Array(n * 2);
  for (let m = 0; m < n; m += 1) {
    out[2 * m] = x[m];
    let acc = 0;
    if (m >= HALF_TAPS && m + HALF_TAPS < n) {
      for (let j = 0; j < HALF_TAPS; j += 1) acc += HALF[j] * (x[m - j] + x[m + 1 + j]);
    } else {
      for (let j = 0; j < HALF_TAPS; j += 1) {
        const a = m - j >= 0 ? x[m - j] : 0;
        const b = m + 1 + j < n ? x[m + 1 + j] : 0;
        acc += HALF[j] * (a + b);
      }
    }
    out[2 * m + 1] = 2 * acc;
  }
  return out;
}

/** Play `rate` times faster by resampling (rate is 1/4, 1/2, 1, 2 or 4). */
export function resampleChannels(channels, rate) {
  let data = channels;
  let r = rate;
  while (r >= 2) {
    data = data.map(decimate2);
    r /= 2;
  }
  while (r <= 0.5) {
    data = data.map(interpolate2);
    r *= 2;
  }
  return data;
}

/**
 * WSOLA time stretch: output is `stretch` times as long at the same pitch.
 * Frames of 30 ms overlap by half under a Hann window. Each frame start is searched
 * within 9 ms of its nominal position for the best normalised match with the natural
 * continuation of the previous frame, first on an ~8 kHz mono guide, then refined at
 * full rate. All channels share the chosen positions so the stereo image holds.
 */
export function wsola(channels, stretch, sampleRate) {
  const count = channels.length;
  const length = count ? channels[0].length : 0;
  const outLength = Math.max(0, Math.round(length * stretch));
  const out = channels.map(() => new Float32Array(outLength));
  if (!count || length === 0 || outLength === 0) return out;

  const frame = 2 * Math.max(8, Math.round(sampleRate * 0.015));
  const hop = frame / 2;
  const analysisHop = hop / stretch;
  const tolerance = Math.max(1, Math.round(sampleRate * 0.009));
  const factor = Math.max(1, Math.round(sampleRate / 8000));

  let mono = channels[0];
  if (count > 1) {
    mono = new Float32Array(length);
    for (let c = 0; c < count; c += 1) {
      const src = channels[c];
      for (let i = 0; i < length; i += 1) mono[i] += src[i];
    }
    for (let i = 0; i < length; i += 1) mono[i] /= count;
  }

  const guideLength = Math.floor(length / factor);
  const guide = new Float32Array(guideLength);
  for (let g = 0; g < guideLength; g += 1) {
    let sum = 0;
    const start = g * factor;
    for (let i = 0; i < factor; i += 1) sum += mono[start + i];
    guide[g] = sum / factor;
  }
  const guideSpan = Math.max(1, Math.floor(hop / factor));

  const window = new Float32Array(frame);
  for (let j = 0; j < frame; j += 1) window[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / frame);

  function search(natural, target) {
    const lo = Math.max(0, target - tolerance);
    const hi = Math.min(length - hop, target + tolerance);
    if (hi < lo || natural + hop > length) return Math.max(0, Math.min(target, length - 1));

    // Coarse pass on the guide.
    const ref = Math.floor(natural / factor);
    const gLo = Math.ceil(lo / factor);
    const gHi = Math.min(Math.floor(hi / factor), guideLength - guideSpan);
    let coarse = target;
    if (gHi >= gLo && ref + guideSpan <= guideLength) {
      const gTarget = target / factor;
      let energy = 0;
      for (let j = 0; j < guideSpan; j += 1) energy += guide[gLo + j] * guide[gLo + j];
      let best = gLo;
      let bestScore = -Infinity;
      for (let p = gLo; p <= gHi; p += 1) {
        let dot = 0;
        for (let j = 0; j < guideSpan; j += 1) dot += guide[p + j] * guide[ref + j];
        const score = dot / Math.sqrt(energy + 1e-12);
        if (score > bestScore
          || (score === bestScore && Math.abs(p - gTarget) < Math.abs(best - gTarget))) {
          best = p;
          bestScore = score;
        }
        const leaving = guide[p];
        const entering = p + guideSpan < guideLength ? guide[p + guideSpan] : 0;
        energy += entering * entering - leaving * leaving;
        if (energy < 0) energy = 0;
      }
      coarse = best * factor;
    }

    // Fine pass at full rate around the coarse pick.
    const fLo = Math.max(lo, coarse - factor);
    const fHi = Math.min(hi, coarse + factor);
    let best = Math.max(lo, Math.min(hi, coarse));
    let bestScore = -Infinity;
    for (let p = fLo; p <= fHi; p += 1) {
      let dot = 0;
      let energy = 0;
      for (let j = 0; j < hop; j += 2) {
        const v = mono[p + j];
        dot += v * mono[natural + j];
        energy += v * v;
      }
      const score = dot / Math.sqrt(energy + 1e-12);
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    return best;
  }

  let previous = 0;
  for (let k = 0, outPos = 0; outPos < outLength; k += 1, outPos += hop) {
    const pos = k === 0 ? 0 : search(previous + hop, Math.round(k * analysisHop));
    const span = Math.min(frame, outLength - outPos, length - pos);
    for (let c = 0; c < count; c += 1) {
      const src = channels[c];
      const dst = out[c];
      for (let j = 0; j < span; j += 1) {
        // The first frame has no predecessor, so its leading half is not faded in.
        const w = k === 0 && j < hop ? 1 : window[j];
        dst[outPos + j] += src[pos + j] * w;
      }
    }
    previous = pos;
  }
  return out;
}

/**
 * Apply speed and pitch to planar channels. Returns the input arrays untouched when the
 * effect is neutral, otherwise new arrays of `effectLength(length, effect)` samples
 * (give or take one per half-band stage).
 */
export function renderEffect(channels, sampleRate, effect) {
  const { speed, pitch } = normalizeEffect(effect);
  if (speed === 1 && pitch === 1) return channels;
  let data = channels;
  // Stretch whichever signal is shorter and never lower than the source pitch.
  if (pitch < 1) data = wsola(data, pitch, sampleRate);
  data = resampleChannels(data, speed * pitch);
  if (pitch > 1) data = wsola(data, pitch, sampleRate);
  return data;
}
