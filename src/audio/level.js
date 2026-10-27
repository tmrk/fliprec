/** Maps an RMS amplitude to a 0..1 meter level: -54 dBFS maps to 0, -6 dBFS to 1. */
export function rmsToLevel(rms) {
  if (!(rms > 1e-8)) return 0;
  const level = (20 * Math.log10(rms) + 54) / 48;
  if (level < 0) return 0;
  if (level > 1) return 1;
  return level;
}
