/**
 * Read 16-bit PCM out of a WAV (skips extra chunks).
 * @param {Buffer | Uint8Array} input
 */
export function decodeWavPcm(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  /** @type {Buffer | null} */
  let data = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buf.length) break;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(start + 2);
      sampleRate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
    }
    offset = start + size + (size & 1);
  }

  if (!data) throw new Error('WAV has no data chunk');
  if (bits !== 16) throw new Error(`Expected 16-bit PCM, got ${bits}`);
  if (data.length % 2 !== 0) throw new Error('WAV data is not an even number of bytes');

  const samples = new Int16Array(data.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2);
  return { channels, sampleRate, samples };
}

/** Per-channel reversal of interleaved PCM. */
export function reverseInterleaved(samples, channels) {
  if (channels < 1 || samples.length % channels !== 0) {
    throw new Error('PCM length is not divisible by the channel count');
  }
  const frames = samples.length / channels;
  const out = new Int16Array(samples.length);
  for (let frame = 0; frame < frames; frame += 1) {
    const src = frame * channels;
    const dst = (frames - 1 - frame) * channels;
    for (let channel = 0; channel < channels; channel += 1) {
      out[dst + channel] = samples[src + channel];
    }
  }
  return out;
}

/** @param {Int16Array} left @param {Int16Array} right */
export function maxAbsDiff(left, right) {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 0; i < left.length; i += 1) {
    const delta = Math.abs(left[i] - right[i]);
    if (delta > max) max = delta;
  }
  return max;
}
