/**
 * Tiny localStorage-backed cache for the keyboard layout definition.
 *
 * The definition is immutable for a given firmware build (the UID
 * changes when the firmware bumps `VIAL_KEYBOARD_ID` and the layout
 * itself only changes when `vial.json` does). Caching it keeps the
 * second-and-later connections fast — no GetSize / GetKeyboardDef
 * round trips, no XZ decompression — and turns the UI from "wait a
 * beat after picker" into "instant ready".
 *
 * Schema (single slot, keyed by UID hex):
 *
 *   localStorage["kobu-editor:keyboard-def"] = JSON.stringify({
 *     uidHex: "b9bc09b29d374cea",
 *     definition: { matrix: { rows, cols }, ... }
 *   })
 *
 * If the stored UID doesn't match the live device, we treat the
 * cached payload as stale and refetch.
 */

import type { KeyboardLayoutDef } from './handshake';

const STORAGE_KEY = 'kobu-editor:keyboard-def';

interface CacheEntry {
  uidHex: string;
  definition: KeyboardLayoutDef;
}

export function uidToHex(uid: Uint8Array): string {
  return Array.from(uid, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function loadCachedDefinition(uid: Uint8Array): KeyboardLayoutDef | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.uidHex !== uidToHex(uid)) return null;
    return entry.definition;
  } catch {
    return null;
  }
}

export function saveCachedDefinition(uid: Uint8Array, definition: KeyboardLayoutDef): void {
  if (typeof localStorage === 'undefined') return;
  const entry: CacheEntry = { uidHex: uidToHex(uid), definition };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Quota / disabled storage is fine — we degrade to refetching.
  }
}

export function clearCachedDefinition(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
