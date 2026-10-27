import { describe, expect, it } from 'vitest';
import { formatRemaining, formatTime, splitTime } from '../../src/lib/format.js';

describe('splitTime', () => {
  it('formats zero', () => {
    expect(splitTime(0)).toEqual({ main: '0:00', tenths: '.0' });
    expect(formatTime(0)).toBe('0:00.0');
  });

  it('truncates 59.95 to 0:59.9 instead of rounding to 0:60', () => {
    const parts = splitTime(59.95);
    expect(parts.main).toBe('0:59');
    expect(parts.tenths).toBe('.9');
    expect(parts.main).not.toBe('0:60');
    expect(formatTime(59.95)).toBe('0:59.9');
  });

  it('formats 61.04', () => {
    expect(splitTime(61.04)).toEqual({ main: '1:01', tenths: '.0' });
    expect(formatTime(61.04)).toBe('1:01.0');
  });

  it('formats 119.99', () => {
    expect(splitTime(119.99)).toEqual({ main: '1:59', tenths: '.9' });
    expect(formatTime(119.99)).toBe('1:59.9');
  });

  it('treats negative and NaN as 0:00.0', () => {
    expect(formatTime(-5)).toBe('0:00.0');
    expect(splitTime(-0.4)).toEqual({ main: '0:00', tenths: '.0' });
    expect(formatTime(NaN)).toBe('0:00.0');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00.0');
  });
});

describe('formatRemaining', () => {
  it('counts down only in the last 15 seconds', () => {
    expect(formatRemaining(104.9)).toBeNull();
    expect(formatRemaining(105)).toBe('0:15 left');
    expect(formatRemaining(112)).toBe('0:08 left');
    expect(formatRemaining(120)).toBe('0:00 left');
  });
});
