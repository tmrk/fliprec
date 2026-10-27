import { beforeEach, describe, expect, it, vi } from 'vitest';

const MAX_BYTES = 30 * 1024 * 1024;

/**
 * Minimal IndexedDB. Success and error handlers run in a microtask so the
 * caller can assign them before they fire. No real 30 MB allocation.
 */
function installFakeIndexedDB() {
  const databases = new Map();
  const stats = { puts: 0, failPut: false, failOpen: false };

  function requestLater(run) {
    const request = {};
    queueMicrotask(() => run(request));
    return request;
  }

  function makeStore(data) {
    return {
      put(value, key) {
        return requestLater((request) => {
          stats.puts += 1;
          if (stats.failPut) {
            request.error = new Error('quota');
            request.onerror?.();
            return;
          }
          data.set(key, value);
          request.result = key;
          request.onsuccess?.();
        });
      },
      get(key) {
        return requestLater((request) => {
          request.result = data.has(key) ? data.get(key) : undefined;
          request.onsuccess?.();
        });
      },
      delete(key) {
        return requestLater((request) => {
          data.delete(key);
          request.result = undefined;
          request.onsuccess?.();
        });
      },
    };
  }

  const indexedDB = {
    open(name) {
      if (stats.failOpen) throw new Error('indexedDB open failed');
      const request = {};
      queueMicrotask(() => {
        if (!databases.has(name)) databases.set(name, new Map());
        const tables = databases.get(name);
        const db = {
          objectStoreNames: {
            contains(store) {
              return tables.has(store);
            },
          },
          createObjectStore(store) {
            if (!tables.has(store)) tables.set(store, new Map());
            return makeStore(tables.get(store));
          },
          transaction(store) {
            const data = tables.get(store);
            return { objectStore: () => makeStore(data) };
          },
          close: vi.fn(),
        };
        request.result = db;
        if (!tables.has('recordings')) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  vi.stubGlobal('indexedDB', indexedDB);
  return stats;
}

async function loadPersist() {
  vi.resetModules();
  return import('../../src/audio/persist.js');
}

describe('persist', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips the last recording and stores only the four fields', async () => {
    const stats = installFakeIndexedDB();
    const { save, load } = await loadPersist();
    const blob = new Blob(['hello'], { type: 'audio/webm' });

    await expect(save({
      blob,
      mimeType: 'audio/webm',
      createdAt: 1700000000000,
      source: 'mic',
      extra: 'drop-me',
    })).resolves.toBe(true);

    const stored = await load();
    expect(stored.blob).toBe(blob);
    expect(stored.mimeType).toBe('audio/webm');
    expect(stored.createdAt).toBe(1700000000000);
    expect(stored.source).toBe('mic');
    expect(stored.extra).toBeUndefined();
    expect(stats.puts).toBe(1);
  });

  it('clears the last recording', async () => {
    installFakeIndexedDB();
    const { save, load, clear } = await loadPersist();
    const blob = new Blob(['x']);
    await save({ blob, mimeType: 'audio/webm', createdAt: 1, source: 'import' });
    await expect(clear()).resolves.toBe(true);
    await expect(load()).resolves.toBeNull();
  });

  it('skips blobs over 30 MB and still saves one of exactly 30 MB', async () => {
    const stats = installFakeIndexedDB();
    const { save, load } = await loadPersist();
    const huge = { size: MAX_BYTES + 1 };
    await expect(save({ blob: huge, mimeType: 'audio/webm', createdAt: 1, source: 'mic' })).resolves.toBe(false);
    expect(stats.puts).toBe(0);
    await expect(load()).resolves.toBeNull();

    const exact = { size: MAX_BYTES };
    await expect(save({
      blob: exact,
      mimeType: 'audio/webm',
      createdAt: 2,
      source: 'mic',
    })).resolves.toBe(true);
    expect(stats.puts).toBe(1);
    const stored = await load();
    expect(stored.blob).toBe(exact);
    expect(stored.createdAt).toBe(2);
  });

  it('resolves without throwing when indexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { save, load, clear } = await loadPersist();
    const blob = new Blob(['a']);
    await expect(save({ blob, mimeType: '', createdAt: 1, source: 'mic' })).resolves.toBe(false);
    await expect(load()).resolves.toBeNull();
    await expect(clear()).resolves.toBe(false);
  });

  it('resolves false when open throws', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('private mode');
      },
    });
    const { save, load, clear } = await loadPersist();
    await expect(save({ blob: new Blob(['a']), mimeType: '', createdAt: 1, source: 'mic' })).resolves.toBe(false);
    await expect(load()).resolves.toBeNull();
    await expect(clear()).resolves.toBe(false);
  });

  it('resolves false when put fails the quota check', async () => {
    const stats = installFakeIndexedDB();
    stats.failPut = true;
    const { save } = await loadPersist();
    await expect(save({
      blob: new Blob(['a']),
      mimeType: 'audio/webm',
      createdAt: 1,
      source: 'mic',
    })).resolves.toBe(false);
    expect(stats.puts).toBe(1);
  });
});
