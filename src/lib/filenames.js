/**
 * `fliprec-original-20261027-093000.m4a`, local time, zero-padded.
 * @param {'original' | 'reversed'} variant
 * @param {Date} date
 * @param {string} ext
 */
export function exportFilename(variant, date, ext) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('');
  const clock = [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
  return `fliprec-${variant}-${stamp}-${clock}.${ext}`;
}
