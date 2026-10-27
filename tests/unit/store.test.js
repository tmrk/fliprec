import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOUNDS_KEY,
  createStore,
  readSoundsPreference,
  writeSoundsPreference,
} from '../../src/engine/store.js';

describe('createStore', () => {
  it('shallow-merges partial updates and keeps untouched keys', () => {
    const store = createStore({ a: 1, b: 2, nested: { x: 1 } });
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState({ b: 3, extra: true });

    expect(store.getState()).toEqual({ a: 1, b: 3, nested: { x: 1 }, extra: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('applies functional updates against the latest state', () => {
    const store = createStore({ n: 1 });
    store.setState((state) => ({ n: state.n + 1 }));
    store.setState((state) => ({ n: state.n + 1 }));
    expect(store.getState().n).toBe(3);
  });

  it('does not notify when the patch changes nothing', () => {
    const store = createStore({ a: 1, b: 2 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState({ a: 1 });
    store.setState((state) => ({ b: state.b }));
    store.setState({});

    expect(listener).not.toHaveBeenCalled();
    expect(store.getState()).toEqual({ a: 1, b: 2 });
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    const other = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.subscribe(other);

    store.setState({ a: 2 });
    unsubscribe();
    store.setState({ a: 3 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    expect(store.getState().a).toBe(3);
  });
});

describe('sounds preference', () => {
  afterEach(() => {
    localStorage.removeItem(SOUNDS_KEY);
    vi.restoreAllMocks();
  });

  it('treats only stored off as disabled', () => {
    localStorage.removeItem(SOUNDS_KEY);
    expect(readSoundsPreference()).toBe(true);
    localStorage.setItem(SOUNDS_KEY, 'on');
    expect(readSoundsPreference()).toBe(true);
    localStorage.setItem(SOUNDS_KEY, 'nope');
    expect(readSoundsPreference()).toBe(true);
    localStorage.setItem(SOUNDS_KEY, 'off');
    expect(readSoundsPreference()).toBe(false);
  });

  it('treats storage errors as on and does not throw when writing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readSoundsPreference()).toBe(true);
    expect(() => writeSoundsPreference(false)).not.toThrow();
  });

  it('persists on and off', () => {
    writeSoundsPreference(true);
    expect(localStorage.getItem(SOUNDS_KEY)).toBe('on');
    writeSoundsPreference(false);
    expect(localStorage.getItem(SOUNDS_KEY)).toBe('off');
  });
});

