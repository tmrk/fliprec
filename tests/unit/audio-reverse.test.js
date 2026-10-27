import { describe, expect, it } from 'vitest';
import { reverseAudioBuffer, reverseChannel } from '../../src/audio/reverse.js';

function ramp(length, offset = 0) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i + offset;
  return out;
}

function expectReversed(actual, original) {
  expect(actual).toBeInstanceOf(Float32Array);
  expect(actual).not.toBe(original);
  expect(actual.length).toBe(original.length);
  for (let i = 0; i < original.length; i += 1) {
    expect(actual[i]).toBe(original[original.length - 1 - i]);
  }
}

function sumOf(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i];
  return sum;
}

function sortedCopy(samples) {
  return Array.from(samples).sort((a, b) => a - b);
}

/** Minimal buffer whose channel storage is a real Float32Array. */
function makeContext() {
  return {
    createBuffer(numberOfChannels, length, sampleRate) {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      return {
        numberOfChannels,
        length,
        sampleRate,
        getChannelData(index) {
          return channels[index];
        },
        copyToChannel(source, index, start = 0) {
          channels[index].set(source, start);
        },
        copyFromChannel(destination, index, start = 0) {
          destination.set(channels[index].subarray(start, start + destination.length));
        },
      };
    },
  };
}

describe('reverseChannel', () => {
  it('reverses a ramp 0..N-1 exactly', () => {
    const original = ramp(8);
    const reversed = reverseChannel(original);
    expect(Array.from(reversed)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expectReversed(reversed, original);
  });

  it('handles odd, even, one-sample, and empty lengths', () => {
    expect(Array.from(reverseChannel(ramp(5)))).toEqual([4, 3, 2, 1, 0]);
    expect(Array.from(reverseChannel(ramp(4)))).toEqual([3, 2, 1, 0]);
    expect(Array.from(reverseChannel(new Float32Array([0.5])))).toEqual([0.5]);
    expect(Array.from(reverseChannel(new Float32Array(0)))).toEqual([]);
  });

  it('preserves polarity and the multiset of values', () => {
    const original = Float32Array.from([-1, 0.25, -0.5, 0.75, 0]);
    const reversed = reverseChannel(original);
    expect(Array.from(reversed)).toEqual([0, 0.75, -0.5, 0.25, -1]);
    expect(sumOf(reversed)).toBe(sumOf(original));
    expect(sortedCopy(reversed)).toEqual(sortedCopy(original));
    for (let i = 0; i < original.length; i += 1) {
      expect(reversed[i]).toBe(original[original.length - 1 - i]);
    }
  });

  it('does not modify the input', () => {
    const original = Float32Array.from([1, -2, 3, -4, 5]);
    const snapshot = Float32Array.from(original);
    reverseChannel(original);
    expect(original).toEqual(snapshot);
  });

  it('is bit-exact when applied twice', () => {
    const original = Float32Array.from([-0.3, 0, 0.125, -1, 0.999, 2]);
    const twice = reverseChannel(reverseChannel(original));
    expect(twice).not.toBe(original);
    for (let i = 0; i < original.length; i += 1) {
      expect(twice[i]).toBe(original[i]);
    }
  });
});

describe('reverseAudioBuffer', () => {
  it('reverses each channel independently and leaves the source untouched', () => {
    const length = 17;
    const rampCh = ramp(length, -8);
    const sine = new Float32Array(length);
    const constant = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      sine[i] = Math.sin(i * 0.37);
      constant[i] = -0.25;
    }

    const ctx = makeContext();
    const buffer = ctx.createBuffer(3, length, 44100);
    buffer.copyToChannel(rampCh, 0);
    buffer.copyToChannel(sine, 1);
    buffer.copyToChannel(constant, 2);
    const before = [0, 1, 2].map((index) => Float32Array.from(buffer.getChannelData(index)));

    const reversed = reverseAudioBuffer(ctx, buffer);

    expect(reversed).not.toBe(buffer);
    expect(reversed.numberOfChannels).toBe(3);
    expect(reversed.length).toBe(length);
    expect(reversed.sampleRate).toBe(44100);

    for (let channel = 0; channel < 3; channel += 1) {
      const source = before[channel];
      const dest = reversed.getChannelData(channel);
      expectReversed(dest, source);
      expect(sumOf(dest)).toBe(sumOf(source));
      expect(sortedCopy(dest)).toEqual(sortedCopy(source));
      const live = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) expect(live[i]).toBe(source[i]);
    }

    const rev0 = reversed.getChannelData(0);
    const rev1 = reversed.getChannelData(1);
    const rev2 = reversed.getChannelData(2);
    expect(rev0[0]).toBe(before[0][length - 1]);
    expect(rev1[0]).toBe(before[1][length - 1]);
    expect(rev2[0]).toBe(-0.25);
    expect(rev0).not.toEqual(rev1);
    expect(Array.from(rev2).every((sample) => sample === -0.25)).toBe(true);
  });

  it('round-trips even, odd, one-sample, and empty buffers bit-exactly', () => {
    const ctx = makeContext();
    const cases = [
      { channels: 2, length: 8, rate: 48000 },
      { channels: 1, length: 7, rate: 22050 },
      { channels: 1, length: 1, rate: 8000 },
      { channels: 2, length: 0, rate: 48000 },
    ];

    for (const spec of cases) {
      const buffer = ctx.createBuffer(spec.channels, spec.length, spec.rate);
      for (let channel = 0; channel < spec.channels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i += 1) {
          data[i] = (i - channel * 3) * 0.125 - 0.5;
        }
      }
      const snapshot = Array.from({ length: spec.channels }, (_, channel) => (
        Float32Array.from(buffer.getChannelData(channel))
      ));

      const once = reverseAudioBuffer(ctx, buffer);
      const twice = reverseAudioBuffer(ctx, once);

      expect(twice.length).toBe(spec.length);
      expect(twice.sampleRate).toBe(spec.rate);
      expect(twice.numberOfChannels).toBe(spec.channels);
      for (let channel = 0; channel < spec.channels; channel += 1) {
        const restored = twice.getChannelData(channel);
        const original = snapshot[channel];
        expect(restored.length).toBe(original.length);
        for (let i = 0; i < original.length; i += 1) {
          expect(restored[i]).toBe(original[i]);
        }
        const live = buffer.getChannelData(channel);
        for (let i = 0; i < live.length; i += 1) expect(live[i]).toBe(original[i]);
      }
    }
  });
});
