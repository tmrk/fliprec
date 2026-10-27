/** Sample-order reversal of one channel. Copies; never flips polarity. */
export function reverseChannel(f32) {
  const out = new Float32Array(f32);
  out.reverse();
  return out;
}

/**
 * New buffer, same length / sampleRate / channel count.
 * Each channel is reversed on its own. The input buffer is left unchanged
 * (`getChannelData` is a live view, so the reverse always runs on a copy).
 */
export function reverseAudioBuffer(ctx, buffer) {
  const reversed = ctx.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  );
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    reversed.copyToChannel(reverseChannel(buffer.getChannelData(channel)), channel);
  }
  return reversed;
}
