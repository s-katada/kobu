/**
 * IndexedDB persistence for the user's XIAO-BOOT directory handle, so the
 * second install can skip the picker. Ported from kobu-editor; the IDB
 * name is scoped to this app (`kobu-zmk-install`) so it doesn't collide
 * with the RMK editor on the same origin.
 */

const DB_NAME = 'kobu-zmk-install';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'xiao-boot';

export function isIdbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('failed to open kobu-zmk-install DB'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  if (!isIdbAvailable()) throw new Error('IndexedDB is not available in this runtime');
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

export async function saveXiaoBootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    await withStore('readwrite', (store) => requestToPromise(store.put(handle, KEY)));
  } catch {
    // Best-effort — next install falls back to the picker.
  }
}

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

export async function clearXiaoBootHandle(): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    await withStore('readwrite', (store) => requestToPromise(store.delete(KEY)));
  } catch {
    // ignore
  }
}

export type HandlePermission = 'granted' | 'prompt' | 'denied';

interface PermissionMethods {
  queryPermission?: (descriptor: { mode: 'readwrite' | 'read' }) => Promise<HandlePermission>;
  requestPermission?: (descriptor: { mode: 'readwrite' | 'read' }) => Promise<HandlePermission>;
}

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

export async function isHandleAccessible(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    await handle.getFileHandle('INFO_UF2.TXT');
    return true;
  } catch {
    return false;
  }
}
