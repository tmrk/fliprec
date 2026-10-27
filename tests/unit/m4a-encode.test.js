// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeM4a } from '../../src/audio/encodeM4a.js';
import { decodeToF32, ffprobeJson, hasFfmpeg } from '../helpers/ffmpeg.js';

const ffmpegAvailable = hasFfmpeg();
const SAMPLE_RATE = 48000;
const DURATION = 2.5;
const FRAME_COUNT = Math.round(DURATION * SAMPLE_RATE);

describe('encodeM4a validation', () => {
  const samples = () => new Float32Array([0.1, -0.2, 0.3]);

  it('rejects the wrong channel count, empty or unequal channels, and sample rates outside 8000-48000', async () => {
    const one = samples();
    const cases = [
      { channels: [], sampleRate: SAMPLE_RATE },
      { channels: [one, one, one], sampleRate: SAMPLE_RATE },
      { channels: [new Float32Array(0)], sampleRate: SAMPLE_RATE },
      { channels: [one, new Float32Array([0.1, -0.2])], sampleRate: SAMPLE_RATE },
      { channels: [[0.1, -0.2, 0.3]], sampleRate: SAMPLE_RATE },
      { channels: [one], sampleRate: 7999 },
      { channels: [one], sampleRate: 48001 },
      { channels: [one], sampleRate: 44100.5 },
    ];
    for (const options of cases) {
      await expect(encodeM4a(options)).rejects.toThrow(Error);
    }
  });
});

describe('encodeM4a output', () => {
  /** @type {string | undefined} */
  let dir;
  /** @type {string} */
  let wasmReason = '';

  beforeAll(async () => {
    if (!ffmpegAvailable) return;
    dir = await mkdtemp(join(tmpdir(), 'fliprec-m4a-'));
    try {
      const warmup = new Float32Array(4800);
      warmup[0] = 0.25;
      await encodeM4a({ channels: [warmup], sampleRate: SAMPLE_RATE });
    } catch (error) {
      wasmReason = error instanceof Error ? error.message : String(error);
    }
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!ffmpegAvailable)('encodes a mono chirp and its sample-reversed copy', async (ctx) => {
    if (wasmReason) ctx.skip(`AAC WASM encoder cannot run in Node: ${wasmReason}`);

    const chirp = linearChirp(FRAME_COUNT, SAMPLE_RATE, 200, 2000, 0.5);
    const reversed = reverse(chirp);
    const original = await writeEncoded(dir, 'mono.m4a', [chirp]);
    const backward = await writeEncoded(dir, 'mono-reversed.m4a', [reversed]);

    expectM4aBrand(original.buffer);
    assertProbe(ffprobeJson(original.path), { channels: 1, sampleRate: SAMPLE_RATE, duration: DURATION });
    assertProbe(ffprobeJson(backward.path), { channels: 1, sampleRate: SAMPLE_RATE, duration: DURATION });

    const decoded = await decodeToF32(original.path, { channels: 1, sampleRate: SAMPLE_RATE });
    const decodedReversed = await decodeToF32(backward.path, { channels: 1, sampleRate: SAMPLE_RATE });
    expect(bestNormalizedCorrelation(chirp, decoded[0], 2048)).toBeGreaterThan(0.9);
    expect(bestNormalizedCorrelation(reversed, decodedReversed[0], 2048)).toBeGreaterThan(0.9);
    expect(bestNormalizedCorrelation(chirp, decodedReversed[0], 2048)).toBeLessThan(0.5);
  }, 60_000);

  it.skipIf(!ffmpegAvailable)('keeps stereo channels in order', async (ctx) => {
    if (wasmReason) ctx.skip(`AAC WASM encoder cannot run in Node: ${wasmReason}`);

    const chirp = linearChirp(FRAME_COUNT, SAMPLE_RATE, 200, 2000, 0.5);
    const tone = sine(FRAME_COUNT, SAMPLE_RATE, 440, 0.5);
    const encoded = await writeEncoded(dir, 'stereo.m4a', [chirp, tone]);

    expectM4aBrand(encoded.buffer);
    assertProbe(ffprobeJson(encoded.path), { channels: 2, sampleRate: SAMPLE_RATE, duration: DURATION });

    const decoded = await decodeToF32(encoded.path, { channels: 2, sampleRate: SAMPLE_RATE });
    expect(bestNormalizedCorrelation(chirp, decoded[0], 2048)).toBeGreaterThan(0.9);
    expect(bestNormalizedCorrelation(tone, decoded[1], 2048)).toBeGreaterThan(0.9);
  }, 60_000);
});

/**
 * @param {string} dir
 * @param {string} name
 * @param {Float32Array[]} channels
 */
async function writeEncoded(dir, name, channels) {
  const { buffer, encoder } = await encodeM4a({ channels, sampleRate: SAMPLE_RATE });
  expect(encoder).toBe('wasm');
  const path = join(dir, name);
  await writeFile(path, Buffer.from(buffer));
  return { buffer, path };
}

/**
 * @param {ArrayBuffer} buffer
 */
function expectM4aBrand(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  expect(view.getUint32(0, false)).toBe(24);
  expect(fourCC(bytes, 4)).toBe('ftyp');
  expect(fourCC(bytes, 8)).toBe('M4A ');
  expect(view.getUint32(12, false)).toBe(0);
  expect(fourCC(bytes, 16)).toBe('M4A ');
  expect(fourCC(bytes, 20)).toBe('isom');
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function fourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * @param {{ format: { format_name: string, duration?: string, bit_rate?: string, tags?: Record<string, string> }, streams: Array<Record<string, unknown>> }} probe
 * @param {{ channels: number, sampleRate: number, duration: number }} expected
 */
function assertProbe(probe, expected) {
  expect(probe.format.format_name).toContain('mov,mp4,m4a');
  expect(probe.format.tags?.major_brand).toBe('M4A ');

  const stream = probe.streams.find((item) => item.codec_type === 'audio');
  expect(stream).toBeTruthy();
  expect(stream.codec_name).toBe('aac');
  expect(stream.profile).toBe('LC');
  expect(stream.channels).toBe(expected.channels);
  expect(Number(stream.sample_rate)).toBe(expected.sampleRate);

  const duration = Number(stream.duration ?? probe.format.duration);
  expect(Math.abs(duration - expected.duration)).toBeLessThanOrEqual(0.05);

  const bitRate = Number(probe.format.bit_rate);
  expect(bitRate).toBeGreaterThanOrEqual(96_000);
  expect(bitRate).toBeLessThanOrEqual(160_000);
}

/**
 * Linear chirp, phase = 2π (f0 t + (f1-f0) t² / (2T)).
 * @param {number} frameCount
 * @param {number} sampleRate
 * @param {number} f0
 * @param {number} f1
 * @param {number} amplitude
 */
function linearChirp(frameCount, sampleRate, f0, f1, amplitude) {
  const out = new Float32Array(frameCount);
  const duration = frameCount / sampleRate;
  for (let i = 0; i < frameCount; i++) {
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
function sine(frameCount, sampleRate, frequency, amplitude) {
  const out = new Float32Array(frameCount);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < frameCount; i++) out[i] = amplitude * Math.sin(omega * i);
  return out;
}

/**
 * @param {Float32Array} channel
 */
function reverse(channel) {
  const copy = new Float32Array(channel);
  copy.reverse();
  return copy;
}

/**
 * Normalized cross-correlation at the best lag inside ±maxLag.
 * Overlap must cover most of `reference` so a short accidental match cannot win.
 * @param {Float32Array} reference
 * @param {Float32Array} candidate
 * @param {number} maxLag
 */
function bestNormalizedCorrelation(reference, candidate, maxLag) {
  const refLen = reference.length;
  const candLen = candidate.length;
  let best = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const start = Math.max(0, -lag);
    const end = Math.min(refLen, candLen - lag);
    if (end - start < refLen * 0.9) continue;
    let dot = 0;
    let energyRef = 0;
    let energyCandidate = 0;
    for (let i = start; i < end; i++) {
      const a = reference[i];
      const b = candidate[i + lag];
      dot += a * b;
      energyRef += a * a;
      energyCandidate += b * b;
    }
    const denom = Math.sqrt(energyRef * energyCandidate);
    if (denom === 0) continue;
    const score = dot / denom;
    if (score > best) best = score;
  }
  return best;
}
