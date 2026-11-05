// IndexedDB persistence: runs, calibration observations, and a key-value
// store for settings and the in-progress run.

const DB_NAME = 'treadline';
const VERSION = 1;

let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('runs', { keyPath: 'id' });
      d.createObjectStore('observations', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const all = (store) => tx(store, 'readonly', (s) => s.getAll());
export const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
export const remove = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
export const clear = (store) => tx(store, 'readwrite', (s) => s.clear());

export const getKv = (key) => tx('kv', 'readonly', (s) => s.get(key));
export const setKv = (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key));
export const deleteKv = (key) => tx('kv', 'readwrite', (s) => s.delete(key));

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Ask the browser not to evict our data under storage pressure.
export async function persist() {
  try {
    return await navigator.storage?.persist?.();
  } catch {
    return false;
  }
}
