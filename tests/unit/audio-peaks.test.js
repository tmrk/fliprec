import { describe, expect, it } from 'vitest';
import { computePeaks, reversePeaks } from '../../src/audio/peaks.js';

function expectCloseArray(actual, expected) {
  expect(actual).toBeInstanceOf(Float32Array);
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i], 6);
  }
}

describe('computePeaks', () => {
  it('takes the max absolute sample across channels in each bucket', () => {
    const left = Float32Array.of(0.125, -0.25, 0.5, 0.0625);
    const right = Float32Array.of(0, 1, -0.125, 0.25);
    const peaks = computePeaks([left, right], 2);
    expect(Array.from(peaks)).toEqual([1, 0.5]);
    expect(left[1]).toBe(-0.25);
    expect(right[1]).toBe(1);
  });

  it('clamps peaks into 0..1', () => {
    const samples = Float32Array.from([-1.4, 0.25, 2, -0.5]);
    expectCloseArray(computePeaks([samples], 4), [1, 0.25, 1, 0.5]);
    expectCloseArray(computePeaks([Float32Array.from([1, -1])], 2), [1, 1]);
  });

  it('splits an even buffer into equal buckets', () => {
    const samples = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.05]);
    expectCloseArray(computePeaks([samples], 3), [0.2, 0.4, 0.5]);
  });

  it('keeps empty buckets when the buffer is shorter than bucketCount', () => {
    const samples = Float32Array.from([0.2, -0.4, 1.5]);
    const peaks = computePeaks([samples], 8);
    expectCloseArray(peaks, [0.2, 0, 0.4, 0, 0, 1, 0, 0]);
  });

  it('returns zeros for empty input', () => {
    expect(Array.from(computePeaks([], 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(computePeaks([new Float32Array(0)], 3))).toEqual([0, 0, 0]);
    expect(Array.from(computePeaks([new Float32Array([0, 0, 0])], 3))).toEqual([0, 0, 0]);
    expect(computePeaks([new Float32Array([0.5])], 0)).toEqual(new Float32Array(0));
  });

  it('maps one sample per bucket when lengths match', () => {
    const samples = Float32Array.from([-0.2, 0.5, -0.1]);
    expectCloseArray(computePeaks([samples], 3), [0.2, 0.5, 0.1]);
  });
});

describe('reversePeaks', () => {
  it('reverses bucket order without touching the input', () => {
    const peaks = Float32Array.of(0.125, 0.5, 0, 1);
    const snapshot = Float32Array.from(peaks);
    const reversed = reversePeaks(peaks);
    expect(Array.from(reversed)).toEqual([1, 0, 0.5, 0.125]);
    expect(Array.from(peaks)).toEqual(Array.from(snapshot));
    expect(reversed).not.toBe(peaks);
  });

  it('round-trips bit-exactly, including an empty peak array', () => {
    const peaks = Float32Array.from([0, 1, 0.25, 0.5]);
    const twice = reversePeaks(reversePeaks(peaks));
    for (let i = 0; i < peaks.length; i += 1) expect(twice[i]).toBe(peaks[i]);
    expect(Array.from(reversePeaks(new Float32Array(0)))).toEqual([]);
  });
});
