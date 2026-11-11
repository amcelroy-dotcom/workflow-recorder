/* WorkFlow Recorder storage -- everything lives on this phone, in this app's
 * own browser storage (IndexedDB). Nothing here is uploaded anywhere.
 *   sessions  one record per recording: meeting, status, transcript so far
 *   pcm       16 kHz audio in 5-second pieces, saved while you record (so a
 *             crash or a dead battery loses at most a few seconds)
 *   audio     the compressed recording (or the file you shared in), for sharing
 *   kv        settings, the WorkFlow pairing, a file shared in from another app */
const DB_NAME = 'workflow-recorder';
const DB_VERSION = 1;
let dbPromise = null;

export function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('pcm')) d.createObjectStore('pcm');
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(storeName, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage was interrupted'));
  }));
}

const req2p = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export const get = (store, key) => run(store, 'readonly', (s) => req2p(s.get(key)));
export const put = (store, value, key) => run(store, 'readwrite', (s) => req2p(key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', (s) => req2p(s.delete(key)));
export const all = (store) => run(store, 'readonly', (s) => req2p(s.getAll()));

const sessionRange = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

export function getPcm(id, index) {
  return get('pcm', [id, index]).then((buf) => (buf ? new Int16Array(buf) : null));
}

export function putPcm(id, index, int16) {
  return put('pcm', int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength), [id, index]);
}

export async function audioBlob(id) {
  const parts = await run('audio', 'readonly', (s) => req2p(s.getAll(sessionRange(id))));
  if (!parts || !parts.length) return null;
  return new Blob(parts, { type: parts[0].type || 'audio/webm' });
}

/** Removes a recording's audio (both kinds) but keeps its transcript. */
export async function deleteAudio(id) {
  await run('pcm', 'readwrite', (s) => req2p(s.delete(sessionRange(id))));
  await run('audio', 'readwrite', (s) => req2p(s.delete(sessionRange(id))));
}

export async function deleteSession(id) {
  await deleteAudio(id);
  await del('sessions', id);
}

export async function setting(key, fallback) {
  const v = await get('kv', 'setting:' + key);
  return v === undefined ? fallback : v;
}

export const setSetting = (key, value) => put('kv', value, 'setting:' + key);
