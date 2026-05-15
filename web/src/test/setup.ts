import '@testing-library/jest-dom/vitest';

// Node 26 ships an experimental built-in `localStorage` that is
// disabled unless the runtime is launched with `--localstorage-file`.
// In its disabled state Node exposes `localStorage` as `undefined`,
// which can win over jsdom's polyfill depending on initialisation
// order. Install an in-memory shim before any test code reads it so
// callers (e.g. `src/protocol/cache.ts`) see a working Storage API.
if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
  let store: Record<string, string> = {};
  const shim: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = {};
    },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? (store[key] ?? null) : null;
    },
    key(index) {
      return Object.keys(store)[index] ?? null;
    },
    removeItem(key) {
      delete store[key];
    },
    setItem(key, value) {
      store[key] = String(value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    writable: true,
    configurable: true,
  });
}
