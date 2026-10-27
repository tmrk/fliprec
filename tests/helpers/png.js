/**
 * PNG IHDR width and height. Bytes 16-23 of a standard signature + IHDR.
 * @param {Buffer | Uint8Array} input
 */
export function pngSize(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 24) throw new Error('PNG is too short');
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i += 1) {
    if (buf[i] !== signature[i]) throw new Error('Not a PNG');
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG is missing IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}
