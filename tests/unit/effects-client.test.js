import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectLength } from '../../src/audio/effect.js';

class FakeWorker {
  static instances = [];

  static throwOnCreate = false;

  constructor(url, options) {
    if (FakeWorker.throwOnCreate) throw new Error('blocked');
    this.url = String(url);
    this.options = options;
    this.posted = [];
    this.listeners = { message: [], error: [], messageerror: [] };
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  addEventListener(type, cb) {
    this.listeners[type].push(cb);
  }

  postMessage(data, transfer) {
    this.posted.push({ data, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  respond(data) {
    for (const cb of this.listeners.message) cb({ data });
  }

  crash(message) {
    for (const cb of this.listeners.error) cb({ message });
  }
}

function ramp(length) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.sin(i / 7) * 0.5;
  return out;
}

async function loadClient() {
  vi.resetModules();
  return import('../../src/audio/effects.js');
}

describe('renderEffectInWorker', () => {
  const original = globalThis.Worker;

  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.throwOnCreate = false;
    globalThis.Worker = FakeWorker;
  });

  afterEach(() => {
    globalThis.Worker = original;
  });

  it('transfers the channels to one module worker and resolves its output', async () => {
    const { renderEffectInWorker } = await loadClient();
    const input = ramp(800);
    const pending = renderEffectInWorker({
      channels: [input],
      sampleRate: 8000,
      effect: { speed: 2, pitch: 1 },
    });
    const [worker] = FakeWorker.instances;
    expect(worker.url).toMatch(/fx\.worker\.js/);
    expect(worker.options).toEqual({ type: 'module' });
    const { data, transfer } = worker.posted[0];
    expect(data.channels[0]).toBe(input);
    expect(data.sampleRate).toBe(8000);
    expect(data.effect).toEqual({ speed: 2, pitch: 1 });
    expect(transfer).toEqual([input.buffer]);

    const out = new Float32Array(400);
    worker.respond({ id: data.id, ok: true, channels: [out] });
    await expect(pending).resolves.toEqual([out]);

    renderEffectInWorker({ channels: [ramp(10)], sampleRate: 8000, effect: { speed: 2, pitch: 1 } });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('cancels a queued render on abort and rejects with AbortError', async () => {
    const { renderEffectInWorker } = await loadClient();
    const abort = new AbortController();
    const pending = renderEffectInWorker({
      channels: [ramp(100)],
      sampleRate: 8000,
      effect: { speed: 1, pitch: 2 },
      signal: abort.signal,
    });
    const [worker] = FakeWorker.instances;
    const { id } = worker.posted[0].data;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.posted[1].data).toEqual({ cancel: id });
    worker.respond({ id, ok: false, error: 'cancelled' });
  });

  it('rejects a worker failure and starts a fresh worker next time', async () => {
    const { renderEffectInWorker } = await loadClient();
    const pending = renderEffectInWorker({
      channels: [ramp(100)],
      sampleRate: 8000,
      effect: { speed: 0.5, pitch: 1 },
    });
    FakeWorker.instances[0].respond({ id: FakeWorker.instances[0].posted[0].data.id, ok: false, error: 'bad' });
    await expect(pending).rejects.toThrow('bad');

    const second = renderEffectInWorker({
      channels: [ramp(100)],
      sampleRate: 8000,
      effect: { speed: 0.5, pitch: 1 },
    });
    FakeWorker.instances[0].crash('boom');
    await expect(second).rejects.toThrow('boom');
    expect(FakeWorker.instances[0].terminated).toBe(true);

    renderEffectInWorker({ channels: [ramp(10)], sampleRate: 8000, effect: { speed: 2, pitch: 2 } });
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it.each([
    ['no Worker', () => { globalThis.Worker = undefined; }],
    ['a blocked Worker', () => { FakeWorker.throwOnCreate = true; }],
  ])('renders on the main thread with %s', async (_label, arrange) => {
    arrange();
    const { renderEffectInWorker } = await loadClient();
    const input = ramp(8000);
    const effect = { speed: 2, pitch: 0.5 };
    const [out] = await renderEffectInWorker({ channels: [input], sampleRate: 8000, effect });
    expect(Math.abs(out.length - effectLength(input.length, effect))).toBeLessThanOrEqual(2);
    expect(out.every(Number.isFinite)).toBe(true);
  });

  it('terminates a worker that stops answering and uses a fresh one next time', async () => {
    vi.useFakeTimers();
    const { renderEffectInWorker } = await loadClient();
    const pending = renderEffectInWorker({ channels: [ramp(800)], sampleRate: 8000, effect: { speed: 2, pitch: 1 } });
    const outcome = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(15100);
    await outcome;
    expect(FakeWorker.instances[0].terminated).toBe(true);

    void renderEffectInWorker({ channels: [ramp(800)], sampleRate: 8000, effect: { speed: 2, pitch: 1 } })
      .catch(() => {});
    expect(FakeWorker.instances).toHaveLength(2);
    vi.useRealTimers();
  });
});
