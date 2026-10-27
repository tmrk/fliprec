const HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const BITS_PER_SAMPLE = 16;

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Clamp to [-1, 1] and quantise. Positive full scale is 32767, negative is -32768. */
function floatToInt16(sample) {
  let value = sample;
  if (value > 1) value = 1;
  else if (value < -1) value = -1;
  const scaled = value < 0 ? value * 0x8000 : value * 0x7fff;
  return scaled;
}

/**
 * 16-bit PCM WAV, little-endian, channels interleaved.
 * `channels` are equal-length Float32Arrays in [-1, 1].
 */
export function encodeWav(channels, sampleRate) {
  const channelCount = channels.length;
  const frameCount = channelCount > 0 && channels[0] ? channels[0].length : 0;
  const blockAlign = channelCount * (BITS_PER_SAMPLE >> 3);
  const dataBytes = frameCount * blockAlign;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const samples = channels[channel];
      const sample = samples && frame < samples.length ? samples[frame] : 0;
      view.setInt16(offset, floatToInt16(sample), true);
      offset += 2;
    }
  }
  return buffer;
}
