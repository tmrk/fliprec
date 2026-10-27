const MIN_SECONDS = 0.25;
// 1e-4 is not exact in float32. Use the value a Float32Array actually stores.
const MIN_PEAK = Math.fround(1e-4);

function asError(error) {
  if (error instanceof Error) return error;
  return new Error('decodeAudioData failed');
}

/**
 * Promise and callback forms. The buffer is copied first because Safari
 * detaches the ArrayBuffer handed to decodeAudioData.
 */
export function decodeToBuffer(ctx, arrayBuffer) {
  const copy = arrayBuffer.slice(0);
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(asError(error));
    };
    let result;
    try {
      result = ctx.decodeAudioData(copy, succeed, fail);
    } catch (error) {
      fail(error);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(succeed, fail);
    }
  });
}

/** Keep the start of the buffer when it is longer than `maxSeconds`. */
export function limitBuffer(ctx, buf, maxSeconds) {
  const maxFrames = Math.floor(maxSeconds * buf.sampleRate);
  if (buf.length <= maxFrames) return buf;
  const frames = Math.max(0, maxFrames);
  const out = ctx.createBuffer(buf.numberOfChannels, frames, buf.sampleRate);
  for (let channel = 0; channel < buf.numberOfChannels; channel += 1) {
    const slice = new Float32Array(frames);
    slice.set(buf.getChannelData(channel).subarray(0, frames));
    out.copyToChannel(slice, channel);
  }
  return out;
}

/**
 * 1 or 2 channels pass through. More than two are averaged into a stereo pair:
 * even indexes are the left group, odd indexes the right group.
 */
export function downmixToStereo(ctx, buf) {
  const count = buf.numberOfChannels;
  if (count <= 2) return buf;
  const frames = buf.length;
  const out = ctx.createBuffer(2, frames, buf.sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let leftCount = 0;
  let rightCount = 0;
  for (let channel = 0; channel < count; channel += 1) {
    if (channel % 2 === 0) leftCount += 1;
    else rightCount += 1;
  }
  for (let channel = 0; channel < count; channel += 1) {
    const data = buf.getChannelData(channel);
    const target = channel % 2 === 0 ? left : right;
    const scale = 1 / (channel % 2 === 0 ? leftCount : rightCount);
    for (let i = 0; i < frames; i += 1) target[i] += data[i] * scale;
  }
  out.copyToChannel(left, 0);
  out.copyToChannel(right, 1);
  return out;
}

function offlineContextConstructor() {
  if (typeof globalThis.OfflineAudioContext === 'function') return globalThis.OfflineAudioContext;
  if (typeof globalThis.webkitOfflineAudioContext === 'function') return globalThis.webkitOfflineAudioContext;
  return null;
}

/** Returns `buf` itself when its rate is already within the limit. */
export function resampleIfNeeded(buf, maxRate = 48000) {
  if (buf.sampleRate <= maxRate) return buf;
  const Ctor = offlineContextConstructor();
  if (!Ctor) return Promise.reject(new Error('OfflineAudioContext is not available'));
  const frames = Math.max(1, Math.round((buf.length * maxRate) / buf.sampleRate));
  const offline = new Ctor(buf.numberOfChannels, frames, maxRate);
  const source = offline.createBufferSource();
  source.buffer = buf;
  source.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}

/** Too short or effectively silent. Peak is compared against 1e-4. */
export function validateRecording(buf) {
  if (!buf || !(buf.sampleRate > 0) || buf.length / buf.sampleRate < MIN_SECONDS) {
    return { ok: false, reason: 'empty' };
  }
  const channels = buf.numberOfChannels || 0;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buf.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const value = data[i];
      const peak = value < 0 ? -value : value;
      if (peak >= MIN_PEAK) return { ok: true };
    }
  }
  return { ok: false, reason: 'empty' };
}
