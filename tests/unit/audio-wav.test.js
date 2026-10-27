import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../src/audio/wav.js';

function ascii(buffer, offset, length) {
  let text = '';
  const bytes = new Uint8Array(buffer, offset, length);
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

function parseWav(buffer) {
  const view = new DataView(buffer);
  const dataSize = view.getUint32(40, true);
  const channels = view.getUint16(22, true);
  const frameCount = channels > 0 ? dataSize / (channels * 2) : 0;
  const samples = [];
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameSamples = [];
    for (let channel = 0; channel < channels; channel += 1) {
      frameSamples.push(view.getInt16(offset, true));
      offset += 2;
    }
    samples.push(frameSamples);
  }
  return {
    riff: ascii(buffer, 0, 4),
    chunkSize: view.getUint32(4, true),
    wave: ascii(buffer, 8, 4),
    fmt: ascii(buffer, 12, 4),
    fmtSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    channels,
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(buffer, 36, 4),
    dataSize,
    samples,
  };
}

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM header and clips at ±1', () => {
    const samples = Float32Array.of(0, 0.5, 1, -1, 2, -3, 0.25);
    const snapshot = Float32Array.from(samples);
    const buffer = encodeWav([samples], 44100);
    const wav = parseWav(buffer);

    expect(buffer.byteLength).toBe(44 + samples.length * 2);
    expect(wav.riff).toBe('RIFF');
    expect(wav.wave).toBe('WAVE');
    expect(wav.fmt).toBe('fmt ');
    expect(wav.data).toBe('data');
    expect(wav.chunkSize).toBe(buffer.byteLength - 8);
    expect(wav.fmtSize).toBe(16);
    expect(wav.audioFormat).toBe(1);
    expect(wav.channels).toBe(1);
    expect(wav.sampleRate).toBe(44100);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.blockAlign).toBe(2);
    expect(wav.byteRate).toBe(44100 * 2);
    expect(wav.dataSize).toBe(samples.length * 2);
    expect(wav.samples.map((frame) => frame[0])).toEqual([
      0,
      16383,
      32767,
      -32768,
      32767,
      -32768,
      8191,
    ]);
    expect(Array.from(samples)).toEqual(Array.from(snapshot));
  });

  it('interleaves stereo frames left then right, little-endian', () => {
    const left = Float32Array.of(1, -1);
    const right = Float32Array.of(0.5, -0.5);
    const buffer = encodeWav([left, right], 48000);
    const wav = parseWav(buffer);
    const bytes = new Uint8Array(buffer);

    expect(wav.channels).toBe(2);
    expect(wav.sampleRate).toBe(48000);
    expect(wav.blockAlign).toBe(4);
    expect(wav.byteRate).toBe(48000 * 4);
    expect(wav.dataSize).toBe(8);
    expect(wav.chunkSize).toBe(36 + 8);
    expect(wav.samples).toEqual([
      [32767, 16383],
      [-32768, -16384],
    ]);

    // 32767 is FF 7F, not 7F FF. -32768 is 00 80.
    expect(bytes[44]).toBe(0xff);
    expect(bytes[45]).toBe(0x7f);
    expect(bytes[48]).toBe(0x00);
    expect(bytes[49]).toBe(0x80);
  });

  it('writes an empty clip as a header with no data frames', () => {
    const buffer = encodeWav([new Float32Array(0)], 16000);
    const wav = parseWav(buffer);
    expect(buffer.byteLength).toBe(44);
    expect(wav.channels).toBe(1);
    expect(wav.sampleRate).toBe(16000);
    expect(wav.dataSize).toBe(0);
    expect(wav.chunkSize).toBe(36);
    expect(wav.byteRate).toBe(32000);
    expect(wav.samples).toEqual([]);
  });
});
