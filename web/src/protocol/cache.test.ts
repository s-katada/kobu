import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCachedDefinition,
  loadCachedDefinition,
  saveCachedDefinition,
  uidToHex,
} from './cache';
import type { KeyboardLayoutDef } from './handshake';

const UID = new Uint8Array([0xb9, 0xbc, 0x09, 0xb2, 0x9d, 0x37, 0x4c, 0xea]);
const UID_HEX = 'b9bc09b29d374cea';
const ALT_UID = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);

function fakeDefinition(name: string): KeyboardLayoutDef {
  return {
    name,
    matrix: { rows: 4, cols: 10 },
    layouts: { keymap: [['0,0']] },
  };
}

describe('uidToHex', () => {
  it('renders 8 bytes as a 16-char lowercase hex string', () => {
    expect(uidToHex(UID)).toBe(UID_HEX);
  });

  it('zero-pads single-digit bytes', () => {
    expect(uidToHex(new Uint8Array([0x01, 0x02, 0x0a, 0xff]))).toBe('01020aff');
  });

  it('handles empty arrays', () => {
    expect(uidToHex(new Uint8Array([]))).toBe('');
  });
});

describe('cache round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves and reloads a definition keyed by UID', () => {
    saveCachedDefinition(UID, fakeDefinition('kobu'));
    const loaded = loadCachedDefinition(UID);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('kobu');
  });

  it('returns null when no cache entry is present', () => {
    expect(loadCachedDefinition(UID)).toBeNull();
  });

  it('returns null when the stored UID does not match', () => {
    saveCachedDefinition(UID, fakeDefinition('kobu'));
    expect(loadCachedDefinition(ALT_UID)).toBeNull();
  });

  it('returns null when the stored payload is corrupt JSON', () => {
    localStorage.setItem('kobu-config:keyboard-def', '{not-json');
    expect(loadCachedDefinition(UID)).toBeNull();
  });

  it('overwrites a previous entry when a new definition is saved', () => {
    saveCachedDefinition(UID, fakeDefinition('first'));
    saveCachedDefinition(UID, fakeDefinition('second'));
    expect(loadCachedDefinition(UID)?.name).toBe('second');
  });

  it('clearCachedDefinition removes the entry', () => {
    saveCachedDefinition(UID, fakeDefinition('kobu'));
    clearCachedDefinition();
    expect(loadCachedDefinition(UID)).toBeNull();
  });

  it('clearCachedDefinition is idempotent when no entry exists', () => {
    expect(() => clearCachedDefinition()).not.toThrow();
    expect(() => clearCachedDefinition()).not.toThrow();
  });
});

describe('cache resilience', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('swallows setItem failures (quota exceeded etc.) without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => saveCachedDefinition(UID, fakeDefinition('kobu'))).not.toThrow();
  });

  it('swallows removeItem failures without throwing', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => clearCachedDefinition()).not.toThrow();
  });
});
