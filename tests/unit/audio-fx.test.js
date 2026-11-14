import { describe, expect, it } from 'vitest';
import {
  decimate2,
  interpolate2,
  renderEffect,
  resampleChannels,
  wsola,
} from '../../src/audio/fx.js';
import {
  effectLength,
  formatStep,
  FX_STEPS,
  isNeutralEffect,
  nextStep,
  normalizeEffect,
} from '../../src/audio/effect.js';

const RATE = 48000;

function sine(freq, seconds, rate = RATE, amp = 0.5) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Frequency from upward zero crossings over the middle 80 percent. */
function frequency(x, rate = RATE) {
  const start = Math.floor(x.length * 0.1);
  const end = Math.floor(x.length * 0.9);
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = start + 1; i < end; i += 1) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + x[i - 1] / (x[i - 1] - x[i]);
      if (first < 0) first = t;
      else crossings += 1;
      last = t;
    }
  }
  return crossings > 0 ? (crossings * rate) / (last - first) : 0;
}

function rms(x, start = 0, end = x.length) {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

/** Lowest RMS over 10 ms windows in the middle 80 percent. */
function minWindowRms(x, rate = RATE) {
  const size = Math.round(rate * 0.01);
  let low = Infinity;
  for (let i = Math.floor(x.length * 0.1); i + size < x.length * 0.9; i += size) {
    low = Math.min(low, rms(x, i, i + size));
  }
  return low;
}

describe('effect values', () => {
  it('cycles 1, 2, 1/2 and back', () => {
    expect(FX_STEPS).toEqual([1, 2, 0.5]);
    expect(nextStep(1)).toBe(2);
    expect(nextStep(2)).toBe(0.5);
    expect(nextStep(0.5)).toBe(1);
    expect(nextStep(3)).toBe(2);
  });

  it('formats steps', () => {
    expect(formatStep(1)).toBe('1×');
    expect(formatStep(2)).toBe('2×');
    expect(formatStep(0.5)).toBe('½×');
  });

  it('normalizes unknown values to 1', () => {
    expect(normalizeEffect(null)).toEqual({ speed: 1, pitch: 1 });
    expect(normalizeEffect({ speed: 4, pitch: 0.5 })).toEqual({ speed: 1, pitch: 0.5 });
    expect(isNeutralEffect({ speed: 1, pitch: 1 })).toBe(true);
    expect(isNeutralEffect({ speed: 2, pitch: 1 })).toBe(false);
    expect(isNeutralEffect(undefined)).toBe(true);
  });

  it('predicts output length from speed only', () => {
    expect(effectLength(48000, { speed: 2, pitch: 0.5 })).toBe(24000);
    expect(effectLength(48000, { speed: 0.5, pitch: 2 })).toBe(96000);
    expect(effectLength(48000, { speed: 1, pitch: 2 })).toBe(48000);
  });
});

describe('half-band resampling', () => {
  it('decimate2 doubles pitch and keeps level', () => {
    const out = decimate2(sine(1000, 1));
    expect(out.length).toBe(24000);
    expect(frequency(out)).toBeCloseTo(2000, 0);
    expect(rms(out, 1000, 23000)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('decimate2 rejects content that would alias', () => {
    const out = decimate2(sine(18000, 1));
    expect(rms(out, 1000, 23000)).toBeLessThan(0.5 / Math.SQRT2 / 300);
  });

  it('interpolate2 halves pitch, keeps the input samples and adds no images', () => {
    const input = sine(1000, 1);
    const out = interpolate2(input);
    expect(out.length).toBe(96000);
    for (let i = 0; i < input.length; i += 997) expect(out[2 * i]).toBe(input[i]);
    expect(frequency(out)).toBeCloseTo(500, 0);
    expect(rms(out, 2000, 94000)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('passes DC at unity both ways', () => {
    const dc = new Float32Array(4000).fill(0.25);
    expect(decimate2(dc)[1000]).toBeCloseTo(0.25, 6);
    expect(interpolate2(dc)[3001]).toBeCloseTo(0.25, 6);
  });

  it('resampleChannels cascades by powers of two', () => {
    const x = sine(500, 1);
    expect(resampleChannels([x], 1)[0]).toBe(x);
    expect(resampleChannels([x], 4)[0].length).toBe(12000);
    expect(resampleChannels([x], 0.25)[0].length).toBe(192000);
    expect(frequency(resampleChannels([x], 4)[0])).toBeCloseTo(2000, 0);
  });
});

describe('wsola', () => {
  it.each([2, 0.5])('stretch %d keeps pitch and level with no dropouts', (stretch) => {
    const input = sine(220, 1.5);
    const [out] = wsola([input], stretch, RATE);
    expect(out.length).toBe(Math.round(input.length * stretch));
    expect(Math.abs(frequency(out) - 220)).toBeLessThan(2);
    expect(rms(out, out.length * 0.1, out.length * 0.9)).toBeCloseTo(rms(input), 1);
    expect(minWindowRms(out)).toBeGreaterThan(0.3);
  });

  it('starts at full level and keeps channels apart', () => {
    const left = sine(200, 1);
    const right = sine(310, 1, RATE, 0.25);
    const [l, r] = wsola([left, right], 2, RATE);
    expect(l.length).toBe(r.length);
    expect(l[100]).toBeCloseTo(left[100], 6);
    expect(Math.abs(frequency(l) - 200)).toBeLessThan(2);
    expect(Math.abs(frequency(r) - 310)).toBeLessThan(8);
    expect(rms(r, 4800, 91200)).toBeCloseTo(0.25 / Math.SQRT2, 1);
  });

  it('handles empty and very short input', () => {
    expect(wsola([new Float32Array(0)], 2, RATE)[0].length).toBe(0);
    const tiny = wsola([sine(300, 0.005)], 2, RATE)[0];
    expect(tiny.length).toBe(480);
    expect(tiny.every(Number.isFinite)).toBe(true);
  });
});

describe('renderEffect', () => {
  const input = sine(300, 1.2);

  it('returns the very same arrays when neutral', () => {
    const channels = [input];
    expect(renderEffect(channels, RATE, { speed: 1, pitch: 1 })).toBe(channels);
  });

  const combos = [];
  for (const speed of FX_STEPS) for (const pitch of FX_STEPS) combos.push([speed, pitch]);

  it.each(combos)('speed %d pitch %d: length follows speed, pitch follows both', (speed, pitch) => {
    const [out] = renderEffect([input], RATE, { speed, pitch });
    const expectedLength = effectLength(input.length, { speed, pitch });
    expect(Math.abs(out.length - expectedLength)).toBeLessThanOrEqual(2);
    const expectedFreq = 300 * speed * pitch;
    expect(Math.abs(frequency(out) - expectedFreq) / expectedFreq).toBeLessThan(0.01);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(minWindowRms(out)).toBeGreaterThan(0.25);
  });

  it('keeps stereo channel identity', () => {
    const left = sine(250, 1);
    const right = sine(400, 1);
    const [l, r] = renderEffect([left, right], RATE, { speed: 2, pitch: 0.5 });
    expect(l.length).toBe(r.length);
    expect(Math.abs(frequency(l) - 250)).toBeLessThan(3);
    expect(Math.abs(frequency(r) - 400)).toBeLessThan(4);
  });

  it('works at 44.1 kHz', () => {
    const x = sine(300, 1, 44100);
    const [out] = renderEffect([x], 44100, { speed: 1, pitch: 2 });
    expect(Math.abs(out.length - x.length)).toBeLessThanOrEqual(1);
    expect(Math.abs(frequency(out, 44100) - 600)).toBeLessThan(6);
  });
});
