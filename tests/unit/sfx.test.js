import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAudioContext } from './helpers/fakeAudio.js';

vi.mock('../../src/audio/context.js', () => ({
  getContext: vi.fn(),
}));

import { getContext } from '../../src/audio/context.js';
import { playSfx, renderSfx, setSfxEnabled, SFX_NAMES } from '../../src/audio/sfx.js';

const LENGTH_MS = {
  tap: 79,
  play: 155,
  pause: 127,
  start: 308,
  stop: 322,
  reverse: 155,
  error: 438,
};

describe('renderSfx', () => {
  it.each([44100, 48000])('renders every cue at %d Hz', (sampleRate) => {
    for (const name of SFX_NAMES) {
      const samples = renderSfx(name, sampleRate);
      expect(samples).toBeInstanceOf(Float32Array);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every(Number.isFinite)).toBe(true);
      expect(samples[0] === 0).toBe(true);
      expect(samples[samples.length - 1] === 0).toBe(true);
      let peak = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const mag = Math.abs(samples[i]);
        if (mag > peak) peak = mag;
      }
      expect(peak).toBeGreaterThanOrEqual(0.05);
      expect(peak).toBeLessThanOrEqual(0.13);
      const ms = (samples.length / sampleRate) * 1000;
      expect(ms).toBeGreaterThanOrEqual(LENGTH_MS[name] - 2);
      expect(ms).toBeLessThanOrEqual(LENGTH_MS[name] + 2);
    }
  });

  it('reverses the play cue sample for sample', () => {
    for (const sampleRate of [44100, 48000]) {
      const play = renderSfx('play', sampleRate);
      const reverse = renderSfx('reverse', sampleRate);
      expect(Array.from(reverse)).toEqual(Array.from(play).reverse());
    }
  });

  it('returns an empty array for an unknown name or a bad rate', () => {
    expect(renderSfx('nope', 44100)).toEqual(new Float32Array(0));
    expect(renderSfx('tap', 0)).toEqual(new Float32Array(0));
    expect(renderSfx('tap', -48000)).toEqual(new Float32Array(0));
    expect(renderSfx('tap', Number.NaN)).toEqual(new Float32Array(0));
  });
});

describe('playSfx', () => {
  let ctx;

  beforeEach(() => {
    ctx = createFakeAudioContext({ sampleRate: 48000 });
    getContext.mockReset();
    getContext.mockReturnValue(ctx);
    setSfxEnabled(true);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  afterEach(() => {
    setSfxEnabled(true);
    delete document.hidden;
    delete navigator.userActivation;
  });

  it('returns 0 and creates no source when disabled', () => {
    setSfxEnabled(false);
    const createSource = vi.spyOn(ctx, 'createBufferSource');
    expect(playSfx('tap')).toBe(0);
    expect(getContext).not.toHaveBeenCalled();
    expect(createSource).not.toHaveBeenCalled();
  });

  it('returns 0 and creates no source while the page is hidden', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const createSource = vi.spyOn(ctx, 'createBufferSource');
    expect(playSfx('tap')).toBe(0);
    expect(getContext).not.toHaveBeenCalled();
    expect(createSource).not.toHaveBeenCalled();
  });

  it('returns 0 when the context is suspended outside a gesture', () => {
    ctx.state = 'suspended';
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { isActive: false },
    });
    const createSource = vi.spyOn(ctx, 'createBufferSource');
    expect(playSfx('tap')).toBe(0);
    expect(createSource).not.toHaveBeenCalled();
    expect(ctx.sources).toHaveLength(0);
  });

  it('returns 0 for an unknown name', () => {
    const createSource = vi.spyOn(ctx, 'createBufferSource');
    expect(playSfx('nope')).toBe(0);
    expect(getContext).not.toHaveBeenCalled();
    expect(createSource).not.toHaveBeenCalled();
  });

  it('connects one BufferSource, caches the buffer, and returns a time after the cue', () => {
    const unique = createFakeAudioContext({ sampleRate: 22050 });
    getContext.mockReturnValue(unique);
    const createBuffer = vi.spyOn(unique, 'createBuffer');
    const now = performance.now();
    const until = playSfx('play');
    expect(unique.sources).toHaveLength(1);
    const source = unique.sources[0];
    expect(source.connect).toHaveBeenCalledWith(unique.destination);
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(source.buffer).toBeTruthy();
    expect(until).toBeGreaterThanOrEqual(now + source.buffer.duration * 1000);
    expect(createBuffer).toHaveBeenCalledTimes(1);

    playSfx('play');
    expect(createBuffer).toHaveBeenCalledTimes(1);
    expect(unique.sources).toHaveLength(2);
    expect(unique.sources[1].buffer).toBe(source.buffer);
    expect(unique.sources[1].connect).toHaveBeenCalledWith(unique.destination);
  });

  it('returns 0 when getContext throws', () => {
    getContext.mockImplementation(() => {
      throw new Error('no context');
    });
    expect(playSfx('tap')).toBe(0);
  });
});
