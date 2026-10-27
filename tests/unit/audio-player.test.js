import { describe, expect, it } from 'vitest';
import { createPlayer } from '../../src/audio/player.js';
import { createFakeAudioContext } from './helpers/fakeAudio.js';

function makeClip(ctx, seconds, value) {
  const frames = Math.round(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  buffer.getChannelData(0).fill(value);
  return buffer;
}

function setup(currentTime = 0) {
  const ctx = createFakeAudioContext({ sampleRate: 100, currentTime, state: 'running' });
  const forward = makeClip(ctx, 10, 0.5);
  const reverse = makeClip(ctx, 10, -0.5);
  const player = createPlayer(() => ctx);
  player.load(forward, reverse);
  return { ctx, forward, reverse, player };
}

function liveSources(ctx) {
  return ctx.sources.filter((source) => source.started && !source.stopped);
}

describe('createPlayer', () => {
  it('stops the forward source before the reverse source starts', () => {
    const { ctx, forward, reverse, player } = setup(2);
    player.play('forward');
    player.play('reverse');

    expect(ctx.sources).toHaveLength(2);
    expect(ctx.gains).toHaveLength(2);
    expect(ctx.sources[0].buffer).toBe(forward);
    expect(ctx.sources[1].buffer).toBe(reverse);
    expect(ctx.sources[0].stopped).toBe(true);
    expect(ctx.sources[1].stopped).toBe(false);
    expect(liveSources(ctx)).toHaveLength(1);
    expect(ctx.events.filter((event) => event.type === 'start').every((event) => event.live === 0)).toBe(true);
    expect(ctx.sources[0].stop.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.sources[1].start.mock.invocationCallOrder[0]);

    const now = 2;
    expect(ctx.sources[0].stop).toHaveBeenCalledWith(now + 0.01);
    const fadeOut = ctx.gains[0].gain.linearRampToValueAtTime.mock.calls.at(-1);
    expect(fadeOut[0]).toBe(0);
    expect(fadeOut[1]).toBeCloseTo(now + 0.006, 6);

    expect(ctx.sources[1].connect).toHaveBeenCalledWith(ctx.gains[1]);
    expect(ctx.gains[1].connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.gains[1].gain.setValueAtTime).toHaveBeenCalledWith(0, now);
    expect(ctx.gains[1].gain.linearRampToValueAtTime.mock.calls[0][0]).toBe(1);
    expect(ctx.gains[1].gain.linearRampToValueAtTime.mock.calls[0][1]).toBeCloseTo(now + 0.006, 6);
    expect(player.getState()).toEqual({ state: 'playing', direction: 'reverse' });
  });

  it('tracks pause and resume against currentTime', () => {
    const { ctx, player } = setup(10);
    player.play('forward', 1);
    expect(player.getPosition()).toBeCloseTo(1);
    expect(player.getDuration()).toBeCloseTo(10);

    ctx.currentTime = 12.5;
    expect(player.getPosition()).toBeCloseTo(3.5);

    player.pause();
    expect(player.getState()).toEqual({ state: 'paused', direction: 'forward' });
    expect(player.getPosition()).toBeCloseTo(3.5);

    ctx.currentTime = 20;
    expect(player.getPosition()).toBeCloseTo(3.5);
    const pausedSources = ctx.sources.length;
    player.pause();
    expect(ctx.sources).toHaveLength(pausedSources);
    expect(player.getState().state).toBe('paused');

    player.resume();
    expect(player.getState()).toEqual({ state: 'playing', direction: 'forward' });
    expect(player.getPosition()).toBeCloseTo(3.5);
    expect(ctx.sources.at(-1).start).toHaveBeenCalledWith(20, 3.5);

    ctx.currentTime = 21.25;
    expect(player.getPosition()).toBeCloseTo(4.75);

    const playingSources = ctx.sources.length;
    player.resume();
    expect(ctx.sources).toHaveLength(playingSources);
    expect(player.getState().state).toBe('playing');
  });

  it('restarts at the seek offset while playing', () => {
    const { ctx, player } = setup(4);
    player.play('forward', 0);
    ctx.currentTime = 4.5;
    player.seek(3);

    const source = ctx.sources.at(-1);
    expect(source.offset).toBe(3);
    expect(source.start).toHaveBeenCalledWith(4.5, 3);
    expect(player.getState()).toEqual({ state: 'playing', direction: 'forward' });
    expect(player.getPosition()).toBeCloseTo(3);
    expect(liveSources(ctx)).toHaveLength(1);

    ctx.currentTime = 5;
    expect(player.getPosition()).toBeCloseTo(3.5);
  });

  it('goes to stopped at position 0 on natural end, once', () => {
    const { ctx, player } = setup(0);
    const seen = [];
    const unsubscribe = player.onChange((next) => seen.push({ ...next }));

    player.play('reverse', 1);
    expect(seen).toEqual([{ state: 'playing', direction: 'reverse' }]);

    ctx.sources.at(-1).dispatchEnded();
    expect(player.getState()).toEqual({ state: 'stopped', direction: 'reverse' });
    expect(player.getPosition()).toBe(0);
    expect(seen.filter((event) => event.state === 'stopped')).toHaveLength(1);
    expect(ctx.sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.gains[0].disconnect).toHaveBeenCalledTimes(1);

    ctx.sources.at(-1).dispatchEnded();
    expect(seen.filter((event) => event.state === 'stopped')).toHaveLength(1);
    expect(player.getPosition()).toBe(0);

    unsubscribe();
    player.play('forward');
    expect(seen).toHaveLength(2);
  });

  it('ignores onended from a source that was already replaced', () => {
    const { ctx, player } = setup(1);
    player.play('forward');
    const first = ctx.sources[0];
    const firstGain = ctx.gains[0];
    player.play('reverse');
    const second = ctx.sources[1];

    first.dispatchEnded();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(firstGain.disconnect).toHaveBeenCalledTimes(1);
    expect(player.getState()).toEqual({ state: 'playing', direction: 'reverse' });
    expect(second.stopped).toBe(false);

    second.dispatchEnded();
    expect(player.getState()).toEqual({ state: 'stopped', direction: 'reverse' });
    expect(player.getPosition()).toBe(0);
  });

  it('keeps a single active source across 50 alternating plays', () => {
    const { ctx, player } = setup(0);
    for (let i = 0; i < 50; i += 1) {
      player.play(i % 2 === 0 ? 'forward' : 'reverse', 0.25);
      expect(liveSources(ctx)).toHaveLength(1);
    }
    expect(ctx.sources).toHaveLength(50);
    expect(ctx.gains).toHaveLength(50);
    expect(ctx.sources.slice(0, -1).every((source) => source.stopped)).toBe(true);
    expect(ctx.sources.at(-1).stopped).toBe(false);
    expect(player.getState()).toEqual({ state: 'playing', direction: 'reverse' });
  });

  it('calls resume() without waiting when the context is suspended', () => {
    const { ctx, player } = setup(0);
    ctx.state = 'suspended';
    ctx.resume.mockImplementation(() => {
      ctx.state = 'running';
      return new Promise(() => {});
    });

    player.play('forward');

    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.sources[0].start).toHaveBeenCalledTimes(1);
    expect(ctx.resume.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.sources[0].start.mock.invocationCallOrder[0]);
    expect(player.getState().state).toBe('playing');
  });

  it('treats pause and resume as no-ops in the wrong state', () => {
    const { ctx, player } = setup(0);
    player.pause();
    player.resume();
    expect(ctx.sources).toHaveLength(0);
    expect(player.getState()).toEqual({ state: 'stopped', direction: 'forward' });

    player.play('forward');
    player.stop();
    const count = ctx.sources.length;
    player.resume();
    expect(ctx.sources).toHaveLength(count);
    expect(player.getState().state).toBe('stopped');
    expect(player.getPosition()).toBe(0);
  });
});
