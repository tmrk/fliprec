import { describe, expect, it } from 'vitest';
import { exportFilename } from '../../src/lib/filenames.js';

describe('exportFilename', () => {
  it('formats a local timestamp', () => {
    const date = new Date(2026, 9, 27, 9, 30, 0);
    expect(exportFilename('original', date, 'm4a')).toBe('fliprec-original-20261027-093000.m4a');
    expect(exportFilename('reversed', date, 'm4a')).toBe('fliprec-reversed-20261027-093000.m4a');
  });

  it('zero-pads month, day, and clock', () => {
    const date = new Date(2026, 0, 1, 0, 0, 7);
    expect(exportFilename('reversed', date, 'wav')).toBe('fliprec-reversed-20260101-000007.wav');
  });

  it('formats the last second of the year', () => {
    const date = new Date(2026, 11, 31, 23, 59, 58);
    expect(exportFilename('original', date, 'm4a')).toBe('fliprec-original-20261231-235958.m4a');
  });
});
