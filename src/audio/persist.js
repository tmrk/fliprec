const DB_NAME = 'fliprec';
const DB_VERSION = 1;
const STORE = 'recordings';
const KEY = 'last';
const MAX_BYTES = 30 * 1024 * 1024;

let dbPromise = null;

function idb() {
  if (typeof indexedDB === 'undefined' || indexedDB == null) return null;
  return indexedDB;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    request.onsuccess = () => finish(resolve, request.result);
    request.onerror = () => finish(reject, request.error || new Error('indexedDB request failed'));
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = idb().open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* another tab is upgrading */
        }
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('indexedDB open failed'));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  return fn(tx.objectStore(STORE));
}

/**
 * Remember the source blob for the last recording. Failures (private mode,
 * quota, missing IndexedDB) resolve false. Blobs over 30 MB are skipped.
 * @param {{ blob: Blob, mimeType?: string, createdAt?: number, source?: string }} record
 * @returns {Promise<boolean>}
 */
export function save(record) {
  return Promise.resolve().then(async () => {
    if (!record?.blob || typeof record.blob.size !== 'number') return false;
    if (record.blob.size > MAX_BYTES) return false;
    if (!idb()) return false;
    await withStore('readwrite', (store) => requestToPromise(store.put({
      blob: record.blob,
      mimeType: record.mimeType || '',
      createdAt: record.createdAt,
      source: record.source,
    }, KEY)));
    return true;
  }).catch(() => false);
}

/** @returns {Promise<{ blob: Blob, mimeType: string, createdAt: number, source: string } | null>} */
export function load() {
  return Promise.resolve().then(async () => {
    if (!idb()) return null;
    const value = await withStore('readonly', (store) => requestToPromise(store.get(KEY)));
    if (!value?.blob) return null;
    return value;
  }).catch(() => null);
}

/** @returns {Promise<boolean>} */
export function clear() {
  return Promise.resolve().then(async () => {
    if (!idb()) return false;
    await withStore('readwrite', (store) => requestToPromise(store.delete(KEY)));
    return true;
  }).catch(() => false);
}
