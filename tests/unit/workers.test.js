import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/audio/encodeM4a.js', () => ({
  encodeM4a: vi.fn(async () => ({ buffer: new ArrayBuffer(8), encoder: 'native' })),
}));

import { encodeM4a } from '../../src/audio/encodeM4a.js';

function installSelf() {
  const posted = [];
  globalThis.self = {
    onmessage: null,
    postMessage: vi.fn((data) => posted.push(data)),
  };
  return posted;
}

async function send(data) {
  globalThis.self.onmessage({ data });
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('workers skip cancelled jobs', () => {
  const original = globalThis.self;

  beforeEach(() => {
    vi.resetModules();
    encodeM4a.mockClear();
  });

  afterEach(() => {
    globalThis.self = original;
  });

  it('encode worker skips a queued id that was cancelled', async () => {
    const posted = installSelf();
    await import('../../src/audio/encode.worker.js');
    await send({ cancel: 2 });
    await send({ id: 1, channels: [new Float32Array(4)], sampleRate: 48000 });
    await send({ id: 2, channels: [new Float32Array(4)], sampleRate: 48000 });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(encodeM4a).toHaveBeenCalledTimes(1);
    expect(posted[0]).toMatchObject({ id: 1, ok: true });
    expect(posted[1]).toEqual({ id: 2, ok: false, error: 'cancelled' });
  });

  it('fx worker renders, transfers the output and skips cancelled ids', async () => {
    const posted = installSelf();
    await import('../../src/audio/fx.worker.js');
    const input = new Float32Array(8000);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 5);
    await send({ cancel: 4 });
    await send({ id: 3, channels: [input], sampleRate: 8000, effect: { speed: 2, pitch: 1 } });
    await send({ id: 4, channels: [input], sampleRate: 8000, effect: { speed: 2, pitch: 1 } });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[0].id).toBe(3);
    expect(posted[0].ok).toBe(true);
    expect(posted[0].channels[0].length).toBe(4000);
    const transfer = globalThis.self.postMessage.mock.calls[0][1];
    expect(transfer).toEqual([posted[0].channels[0].buffer]);
    expect(posted[1]).toEqual({ id: 4, ok: false, error: 'cancelled' });
  });
});
