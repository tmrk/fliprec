import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Mp4OutputFormat,
  Output,
  canEncodeAudio,
} from 'mediabunny';

/** @type {boolean} */
let aacEncoderRegistered = false;

/**
 * Pick native WebCodecs AAC, or register the WASM encoder once per realm.
 * Once the WASM encoder is registered, Mediabunny prefers it for every later encode.
 * @returns {Promise<'native' | 'wasm'>}
 */
export async function ensureAacEncoder({
  numberOfChannels,
  sampleRate,
  bitrate,
  forceFallback = false,
}) {
  if (aacEncoderRegistered) return 'wasm';

  const nativeOk = !forceFallback && await canEncodeAudio('aac', {
    numberOfChannels,
    sampleRate,
    bitrate,
  });
  if (nativeOk) return 'native';

  const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
  registerAacEncoder();
  aacEncoderRegistered = true;
  return 'wasm';
}

/**
 * Encode planar PCM to an AAC-LC M4A (MP4) ArrayBuffer.
 * Runs in the encode worker and in Node tests. If the native encoder is
 * advertised but fails mid-encode, retries once with the WASM encoder.
 * Priming samples are skipped with an edit list so the file's duration matches
 * the PCM instead of the padded AAC frame count.
 * @param {{ channels: Float32Array[], sampleRate: number, bitrate?: number, forceFallback?: boolean }} options
 * @returns {Promise<{ buffer: ArrayBuffer, encoder: 'native' | 'wasm' }>}
 */
export async function encodeM4a({
  channels,
  sampleRate,
  bitrate = 128000,
  forceFallback = false,
}) {
  validatePcm(channels, sampleRate);

  const config = { numberOfChannels: channels.length, sampleRate, bitrate };
  const encoder = await ensureAacEncoder({ ...config, forceFallback });
  try {
    return await finishEncode(await muxAac(channels, sampleRate, bitrate), encoder, channels, sampleRate);
  } catch (error) {
    if (encoder !== 'native') throw error;
    await ensureAacEncoder({ ...config, forceFallback: true });
    return await finishEncode(await muxAac(channels, sampleRate, bitrate), 'wasm', channels, sampleRate);
  }
}

/**
 * @param {ArrayBuffer} buffer
 * @param {'native' | 'wasm'} encoder
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 */
async function finishEncode(buffer, encoder, channels, sampleRate) {
  const delay = encoder === 'wasm'
    ? WASM_AAC_DELAY
    : await nativeAacDelay(sampleRate, channels.length);
  return {
    buffer: applyGaplessEdit(buffer, delay, channels[0].length, sampleRate),
    encoder,
  };
}

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} bitrate
 */
async function muxAac(channels, sampleRate, bitrate) {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const source = new AudioSampleSource({ codec: 'aac', bitrate });
  output.addAudioTrack(source);

  try {
    await output.start();
    await writeChunks(source, channels, sampleRate);
    source.close();
    await output.finalize();
  } catch (error) {
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => {});
    }
    throw error;
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Encoder produced no buffer');
  patchFtypInPlace(buffer);
  return buffer;
}

/**
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 */
function validatePcm(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) {
    throw new Error('Expected 1 or 2 channels');
  }

  const length = channels[0] instanceof Float32Array ? channels[0].length : 0;
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error('Channels must be non-empty and of equal length');
  }
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== length) {
      throw new Error('Channels must be non-empty Float32Arrays of equal length');
    }
  }

  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    throw new Error('sampleRate must be an integer from 8000 to 48000');
  }
}

/**
 * Feed ~1 s of planar frames at a time. Planar layout is channel blocks concatenated.
 * @param {AudioSampleSource} source
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 */
async function writeChunks(source, channels, sampleRate) {
  const frameCount = channels[0].length;
  const channelCount = channels.length;

  for (let offset = 0; offset < frameCount; offset += sampleRate) {
    const count = Math.min(sampleRate, frameCount - offset);
    const data = new Float32Array(count * channelCount);
    for (let channel = 0; channel < channelCount; channel++) {
      data.set(channels[channel].subarray(offset, offset + count), channel * count);
    }

    const sample = new AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: channelCount,
      sampleRate,
      timestamp: offset / sampleRate,
    });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
  }
}

/**
 * Rewrite the leading ftyp box in place: major brand `M4A `, minor 0,
 * compatible brands `M4A ` and `isom`. The box stays 24 bytes, so later
 * chunk offsets do not move. Any other layout is left untouched.
 * @param {ArrayBuffer} buffer
 */
function patchFtypInPlace(buffer) {
  if (buffer.byteLength < 24) return;

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const size = view.getUint32(0, false);
  if (size !== 24 || readFourCC(bytes, 4) !== 'ftyp') return;

  writeFourCC(bytes, 8, 'M4A ');
  view.setUint32(12, 0, false);
  writeFourCC(bytes, 16, 'M4A ');
  writeFourCC(bytes, 20, 'isom');
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readFourCC(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {string} text
 */
function writeFourCC(bytes, offset, text) {
  for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i);
}

/**
 * FFmpeg AAC-LC (`@mediabunny/aac-encoder`) delays the signal by one frame.
 * Measured by correlation against the source PCM.
 */
const WASM_AAC_DELAY = 1024;

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** @type {Map<string, Promise<number>>} */
const nativeDelayByKey = new Map();

/**
 * WebCodecs AAC priming is platform-specific (2112 samples on Apple). Measure
 * once per sample rate and channel count. 0 means the file is left untrimmed.
 * @param {number} sampleRate
 * @param {number} numberOfChannels
 */
function nativeAacDelay(sampleRate, numberOfChannels) {
  const key = `${sampleRate}:${numberOfChannels}`;
  let pending = nativeDelayByKey.get(key);
  if (!pending) {
    pending = probeNativeAacDelay(sampleRate, numberOfChannels).catch(() => 0);
    nativeDelayByKey.set(key, pending);
  }
  return pending;
}

/**
 * @param {number} sampleRate
 * @param {number} numberOfChannels
 */
function aacAudioSpecificConfig(sampleRate, numberOfChannels) {
  const index = AAC_SAMPLE_RATES.indexOf(sampleRate);
  if (index < 0 || numberOfChannels < 1 || numberOfChannels > 7) return null;
  const bits = (2 << 11) | (index << 7) | (numberOfChannels << 3);
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff]);
}

/**
 * @param {number} sampleRate
 * @param {number} numberOfChannels
 * @returns {Promise<number>}
 */
async function probeNativeAacDelay(sampleRate, numberOfChannels) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return 0;
  const description = aacAudioSpecificConfig(sampleRate, numberOfChannels);
  if (!description) return 0;

  const frames = 4096;
  const reference = new Float32Array(frames);
  const omega = (2 * Math.PI * 440) / sampleRate;
  for (let i = 0; i < frames; i++) reference[i] = 0.5 * Math.sin(omega * i);

  const data = new Float32Array(frames * numberOfChannels);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    data.set(reference, channel * frames);
  }

  /** @type {{ timestamp: number, duration: number, bytes: Uint8Array }[]} */
  const packets = [];
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push({
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? 0,
        bytes,
      });
    },
    error: () => {},
  });

  try {
    encoder.configure({
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels,
      bitrate: 128000,
    });
    const audio = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels,
      timestamp: 0,
      data,
    });
    encoder.encode(audio);
    audio.close();
    await encoder.flush();
  } catch {
    return 0;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (packets.length === 0) return 0;

  /** @type {Float32Array[]} */
  const planes = [];
  let failed = false;
  const decoder = new AudioDecoder({
    output: (audioData) => {
      const plane = new Float32Array(audioData.numberOfFrames);
      audioData.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
      planes.push(plane);
      audioData.close();
    },
    error: () => {
      failed = true;
    },
  });

  try {
    decoder.configure({
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels,
      description,
    });
    for (const packet of packets) {
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: packet.timestamp,
        duration: packet.duration,
        data: packet.bytes,
      }));
    }
    await decoder.flush();
  } catch {
    return 0;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failed || planes.length === 0) return 0;

  const decoded = new Float32Array(planes.reduce((sum, plane) => sum + plane.length, 0));
  let offset = 0;
  for (const plane of planes) {
    decoded.set(plane, offset);
    offset += plane.length;
  }
  return bestEncoderDelay(reference, decoded);
}

/**
 * Lag of `decoded` against `reference`. 0 when the match is weak, so the
 * caller leaves the container alone.
 * @param {Float32Array} reference
 * @param {Float32Array} decoded
 */
function bestEncoderDelay(reference, decoded) {
  const limit = Math.min(reference.length, 2048);
  const maxLag = Math.min(3072, Math.max(0, decoded.length - limit));
  let bestLag = 0;
  let best = -1;

  for (let lag = 0; lag <= maxLag; lag++) {
    let dot = 0;
    let refEnergy = 0;
    let decodedEnergy = 0;
    for (let i = 0; i < limit; i++) {
      const sample = decoded[i + lag];
      const source = reference[i];
      dot += source * sample;
      refEnergy += source * source;
      decodedEnergy += sample * sample;
    }
    const denom = Math.sqrt(refEnergy * decodedEnergy);
    const score = denom > 0 ? dot / denom : -1;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }

  return best >= 0.8 ? bestLag : 0;
}

/**
 * Insert a one-entry edit list that skips `delaySamples` and presents
 * `frameCount` samples. mvhd/tkhd durations follow that window. Chunk offsets
 * move by the inserted box when moov precedes mdat. Unrecognised layouts are
 * returned unchanged.
 * @param {ArrayBuffer} buffer
 * @param {number} delaySamples
 * @param {number} frameCount
 * @param {number} sampleRate
 */
function applyGaplessEdit(buffer, delaySamples, frameCount, sampleRate) {
  if (!Number.isInteger(delaySamples) || delaySamples <= 0) return buffer;
  if (!Number.isInteger(frameCount) || frameCount <= delaySamples) return buffer;

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const moov = findChild(bytes, view, 0, bytes.length, 'moov');
  const mdat = findChild(bytes, view, 0, bytes.length, 'mdat');
  if (!moov || !mdat || moov.offset > mdat.offset) return buffer;

  const mvhd = findChild(bytes, view, moov.offset + 8, moov.offset + moov.size, 'mvhd');
  const trak = findChild(bytes, view, moov.offset + 8, moov.offset + moov.size, 'trak');
  if (!mvhd || !trak || bytes[mvhd.offset + 8] !== 0) return buffer;

  const tkhd = findChild(bytes, view, trak.offset + 8, trak.offset + trak.size, 'tkhd');
  const mdia = findChild(bytes, view, trak.offset + 8, trak.offset + trak.size, 'mdia');
  if (!tkhd || !mdia || bytes[tkhd.offset + 8] !== 0) return buffer;
  if (tkhd.offset + tkhd.size !== mdia.offset) return buffer;
  if (findChild(bytes, view, trak.offset + 8, trak.offset + trak.size, 'edts')) return buffer;

  const mdhd = findChild(bytes, view, mdia.offset + 8, mdia.offset + mdia.size, 'mdhd');
  const minf = findChild(bytes, view, mdia.offset + 8, mdia.offset + mdia.size, 'minf');
  if (!mdhd || !minf || bytes[mdhd.offset + 8] !== 0) return buffer;

  const stbl = findChild(bytes, view, minf.offset + 8, minf.offset + minf.size, 'stbl');
  if (!stbl) return buffer;
  const stco = findChild(bytes, view, stbl.offset + 8, stbl.offset + stbl.size, 'stco');
  const co64 = stco ? null : findChild(bytes, view, stbl.offset + 8, stbl.offset + stbl.size, 'co64');
  const chunkBox = stco || co64;
  if (!chunkBox || bytes[chunkBox.offset + 8] !== 0) return buffer;

  const mediaScale = view.getUint32(mdhd.offset + 20, false);
  const mediaSamples = view.getUint32(mdhd.offset + 24, false);
  if (mediaScale !== sampleRate || mediaSamples < delaySamples + frameCount) return buffer;

  const movieScale = view.getUint32(mvhd.offset + 20, false);
  if (movieScale === 0) return buffer;
  const segment = Math.round((frameCount / sampleRate) * movieScale);
  if (!Number.isSafeInteger(segment) || segment <= 0 || segment > 0xffffffff) return buffer;

  const edts = editListBox(segment, delaySamples);
  const insertAt = mdia.offset;
  const shift = edts.length;
  const out = new Uint8Array(bytes.length + shift);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(edts, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + shift);

  const outView = new DataView(out.buffer);
  outView.setUint32(moov.offset, moov.size + shift, false);
  outView.setUint32(trak.offset, trak.size + shift, false);
  outView.setUint32(mvhd.offset + 24, segment, false);
  outView.setUint32(tkhd.offset + 28, segment, false);

  const chunkAt = chunkBox.offset + (chunkBox.offset >= insertAt ? shift : 0);
  const entryCount = outView.getUint32(chunkAt + 12, false);
  const entryBytes = stco ? 4 : 8;
  if (chunkAt + 16 + entryCount * entryBytes > chunkAt + chunkBox.size) return buffer;

  for (let i = 0; i < entryCount; i++) {
    const at = chunkAt + 16 + i * entryBytes;
    if (stco) {
      const offset = outView.getUint32(at, false);
      if (offset >= insertAt) outView.setUint32(at, offset + shift, false);
    } else {
      const offset = outView.getBigUint64(at, false);
      if (offset >= BigInt(insertAt)) outView.setBigUint64(at, offset + BigInt(shift), false);
    }
  }

  return out.buffer;
}

/**
 * @param {number} segmentDuration movie timescale
 * @param {number} mediaTime track timescale (samples)
 */
function editListBox(segmentDuration, mediaTime) {
  const edts = new Uint8Array(36);
  const view = new DataView(edts.buffer);
  view.setUint32(0, 36, false);
  writeFourCC(edts, 4, 'edts');
  view.setUint32(8, 28, false);
  writeFourCC(edts, 12, 'elst');
  view.setUint32(16, 0, false);
  view.setUint32(20, 1, false);
  view.setUint32(24, segmentDuration, false);
  view.setInt32(28, mediaTime, false);
  view.setUint32(32, 0x00010000, false);
  return edts;
}

/**
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {number} start
 * @param {number} end
 * @param {string} type
 */
function findChild(bytes, view, start, end, type) {
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset, false);
    if (size < 8 || offset + size > end) return null;
    if (readFourCC(bytes, offset + 4) === type) return { offset, size };
    offset += size;
  }
  return null;
}
