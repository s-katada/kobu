/**
 * IndexedDB-backed persistence for the user's XIAO-BOOT directory
 * handle.
 *
 * The first time the user installs firmware they pick the XIAO-BOOT
 * directory via `showDirectoryPicker()`. We stash the resulting
 * `FileSystemDirectoryHandle` here so the second install can skip the
 * picker entirely — Chrome can re-grant `readwrite` permission on a
 * saved handle silently (no user gesture) **when permission is still
 * 'granted'**. If it has decayed to 'prompt' the next install needs a
 * fresh click to re-acquire.
 *
 * Why IndexedDB and not localStorage:
 *   * `FileSystemDirectoryHandle` is structured-cloneable; localStorage
 *     only stores strings.
 *   * Origin-scoped + survives across tab restarts.
 *
 * Why not pull in `idb-keyval`:
 *   * One-key, one-store usage. The dependency footprint isn't worth
 *     it. Hand-rolled wrapper is ~80 LOC and lives next to the only
 *     caller.
 */

const DB_NAME = 'kobu-install';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'xiao-boot';

/**
 * True when the runtime exposes IndexedDB. Node's jsdom doesn't ship
 * IDB by default — tests opt in via `fake-indexeddb`. The runtime
 * detection lets the install flow gracefully skip persistence when
 * IDB isn't available (e.g. a stripped-down environment).
 */
export function isIdbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('failed to open kobu-install DB'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  if (!isIdbAvailable()) {
    throw new Error('IndexedDB is not available in this runtime');
  }
  const db = await openDB();
  try {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = await fn(store);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
    return result;
  } finally {
    db.close();
  }
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

/**
 * Save the directory handle for future installs. Overwrites any
 * previously-saved handle.
 *
 * Silently no-ops when IndexedDB isn't available — saving is a
 * performance / UX optimisation, not load-bearing for correctness.
 */
export async function saveXiaoBootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    await withStore('readwrite', (store) => requestToPromise(store.put(handle, KEY)));
  } catch {
    // Persisting is best-effort. The next install will fall back to
    // the directory picker — no functional break, just slower UX.
  }
}

/**
 * Return the previously-saved handle, or null if none.
 *
 * The caller still needs to verify `queryPermission()` (the handle
 * may have decayed to 'prompt' after the page was closed for a
 * while) AND probe a known file (`INFO_UF2.TXT`) to confirm the
 * volume is still mounted — the handle persists across mount/unmount
 * but writes will fail if the volume is currently absent.
 */
export async function loadXiaoBootHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!isIdbAvailable()) return null;
  try {
    const result = await withStore('readonly', (store) =>
      requestToPromise(store.get(KEY) as IDBRequest<FileSystemDirectoryHandle | undefined>),
    );
    return result ?? null;
  } catch {
    return null;
  }
}

/** Drop the saved handle (e.g. after a permission-revoke recovery). */
export async function clearXiaoBootHandle(): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    await withStore('readwrite', (store) => requestToPromise(store.delete(KEY)));
  } catch {
    // ignore — see saveXiaoBootHandle
  }
}

export type HandlePermission = 'granted' | 'prompt' | 'denied';

interface PermissionMethods {
  queryPermission?: (descriptor: { mode: 'readwrite' | 'read' }) => Promise<HandlePermission>;
  requestPermission?: (descriptor: { mode: 'readwrite' | 'read' }) => Promise<HandlePermission>;
}

/**
 * Check the current permission state for `readwrite` on the handle
 * without prompting. Returns `'denied'` if the API isn't exposed
 * (rare — older Chromium handles).
 */
export async function queryHandlePermission(
  handle: FileSystemDirectoryHandle,
): Promise<HandlePermission> {
  const h = handle as FileSystemDirectoryHandle & PermissionMethods;
  if (!h.queryPermission) return 'denied';
  try {
    return await h.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/**
 * Request `readwrite` permission. Must be called from within a user
 * gesture handler — Chrome rejects the prompt otherwise.
 */
export async function requestHandlePermission(
  handle: FileSystemDirectoryHandle,
): Promise<HandlePermission> {
  const h = handle as FileSystemDirectoryHandle & PermissionMethods;
  if (!h.requestPermission) return 'denied';
  try {
    return await h.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/**
 * Probe a saved handle: is the underlying directory still mounted
 * and accessible? Used to detect "user unmounted XIAO-BOOT before the
 * second install" and fall back to the picker rather than failing
 * deep in the write step.
 */
export async function isHandleAccessible(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    await handle.getFileHandle('INFO_UF2.TXT');
    return true;
  } catch {
    return false;
  }
}
