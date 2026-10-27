/**
 * Max |sample| across channels in each equal time slice, clamped to 0..1.
 * Bucket of sample i is floor(i * bucketCount / length). When the buffer is
 * shorter than bucketCount, samples land in separate buckets and the gaps stay 0.
 * One pass, no per-sample allocation.
 */
export function computePeaks(channels, bucketCount) {
  const count = Number.isFinite(bucketCount) ? Math.max(0, Math.floor(bucketCount)) : 0;
  const out = new Float32Array(count);
  if (count === 0 || !channels || channels.length === 0) return out;

  const length = channels[0]?.length ?? 0;
  if (length === 0) return out;

  for (let c = 0; c < channels.length; c += 1) {
    const data = channels[c];
    if (!data) continue;
    const frames = data.length < length ? data.length : length;
    for (let i = 0; i < frames; i += 1) {
      const bucket = Math.min(count - 1, Math.floor((i * count) / length));
      let value = data[i];
      if (value < 0) value = -value;
      if (value > 1) value = 1;
      if (value > out[bucket]) out[bucket] = value;
    }
  }
  return out;
}

/** Copy of `peaks` with the bucket order reversed. */
export function reversePeaks(peaks) {
  const out = new Float32Array(peaks.length);
  const last = peaks.length - 1;
  for (let i = 0; i <= last; i += 1) out[i] = peaks[last - i];
  return out;
}
