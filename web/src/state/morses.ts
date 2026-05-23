/**
 * Morse / tap-dance store. Same baseline-vs-local pattern as the
 * combo store — there is no batch path on the wire, so each entry is
 * fetched / saved one at a time.
 *
 * Validation surfaced via selectors:
 *   * tap-term outside [50, 1000] ms → `out-of-range`
 *   * every keycode slot zero       → `no-op`
 *
 * Both are advisories; the firmware accepts whatever we send. The UI
 * shows them as warnings, not hard blockers.
 */

import { create } from 'zustand';
import { fetchDynamicEntryCounts } from '../protocol/combos';
import type { MorseEntry } from '../protocol/commands';
import {
  emptyMorse,
  entriesEqual,
  fetchAllMorses,
  MAX_TAP_TERM_MS,
  MIN_TAP_TERM_MS,
  setMorse,
} from '../protocol/morses';
import { fetchUnlockStatus } from '../protocol/unlock';
import type { WebHidTransport } from '../transport/webhid';

export type MorseEditorPhase =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving'; sent: number; total: number }
  | { kind: 'error'; message: string };

export interface MorseEditorState {
  phase: MorseEditorPhase;
  transport: WebHidTransport | null;
  count: number;
  baseline: MorseEntry[];
  local: MorseEntry[];

  attach: (transport: WebHidTransport) => Promise<void>;
  detach: () => void;
  updateEntry: (index: number, entry: MorseEntry) => void;
  setTap: (index: number, keycode: number) => void;
  setHold: (index: number, keycode: number) => void;
  setDoubleTap: (index: number, keycode: number) => void;
  setHoldAfterTap: (index: number, keycode: number) => void;
  setTapTerm: (index: number, ms: number) => void;
  clearEntry: (index: number) => void;
  resetEntry: (index: number) => void;
  applyPreset: (index: number, preset: MorsePreset) => void;
  save: () => Promise<void>;
  reloadFromDevice: () => Promise<void>;
}

export interface MorsePreset {
  name: string;
  description: string;
  build: (basis: MorseEntry) => MorseEntry;
}

function cloneEntries(entries: MorseEntry[]): MorseEntry[] {
  return entries.map((e) => ({ ...e }));
}

function dirtyIndices(baseline: MorseEntry[], local: MorseEntry[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < local.length; i++) {
    const b = baseline[i];
    const l = local[i];
    if (!b || !l) continue;
    if (!entriesEqual(b, l)) out.push(i);
  }
  return out;
}

export const useMorseStore = create<MorseEditorState>((set, get) => ({
  phase: { kind: 'empty' },
  transport: null,
  count: 0,
  baseline: [],
  local: [],

  attach: async (transport) => {
    set({ phase: { kind: 'loading' }, transport, baseline: [], local: [] });
    try {
      const counts = await fetchDynamicEntryCounts(transport);
      const fetched = await fetchAllMorses(transport, counts.tapDance);
      set({
        count: counts.tapDance,
        baseline: fetched,
        local: cloneEntries(fetched),
        phase: { kind: 'ready' },
      });
    } catch (err) {
      set({ phase: { kind: 'error', message: String(err) } });
    }
  },

  detach: () => {
    set({
      phase: { kind: 'empty' },
      transport: null,
      count: 0,
      baseline: [],
      local: [],
    });
  },

  updateEntry: (index, entry) => {
    const { local } = get();
    if (!local[index]) return;
    const next = cloneEntries(local);
    next[index] = { ...entry };
    set({ local: next });
  },

  setTap: (index, keycode) => {
    setField(get, set, index, (e) => ({ ...e, tap: keycode }));
  },

  setHold: (index, keycode) => {
    setField(get, set, index, (e) => ({ ...e, hold: keycode }));
  },

  setDoubleTap: (index, keycode) => {
    setField(get, set, index, (e) => ({ ...e, doubleTap: keycode }));
  },

  setHoldAfterTap: (index, keycode) => {
    setField(get, set, index, (e) => ({ ...e, holdAfterTap: keycode }));
  },

  setTapTerm: (index, ms) => {
    setField(get, set, index, (e) => ({ ...e, tapTermMs: ms }));
  },

  clearEntry: (index) => {
    const { local } = get();
    if (!local[index]) return;
    const next = cloneEntries(local);
    next[index] = emptyMorse();
    set({ local: next });
  },

  resetEntry: (index) => {
    const { local, baseline } = get();
    if (!local[index] || !baseline[index]) return;
    const next = cloneEntries(local);
    next[index] = { ...baseline[index] };
    set({ local: next });
  },

  applyPreset: (index, preset) => {
    const { local } = get();
    const current = local[index];
    if (!current) return;
    const next = cloneEntries(local);
    next[index] = preset.build(current);
    set({ local: next });
  },

  save: async () => {
    const { transport, baseline, local } = get();
    if (!transport) return;
    const dirty = dirtyIndices(baseline, local);
    if (dirty.length === 0) return;

    try {
      const status = await fetchUnlockStatus(transport);
      if (status.locked) {
        set({
          phase: {
            kind: 'error',
            message:
              'デバイスがロックされています。アンロックコード（両外側 pinky 同時押し）を保持して書き込みを許可してください。',
          },
        });
        return;
      }
    } catch (err) {
      set({ phase: { kind: 'error', message: `アンロック状態の取得に失敗しました: ${err}` } });
      return;
    }

    set({ phase: { kind: 'saving', sent: 0, total: dirty.length } });
    const updatedBaseline = cloneEntries(baseline);
    let sent = 0;
    try {
      for (const idx of dirty) {
        const value = local[idx];
        if (!value) continue;
        await setMorse(transport, idx, value);
        updatedBaseline[idx] = { ...value };
        sent++;
        set({ phase: { kind: 'saving', sent, total: dirty.length } });
      }
      set({ baseline: updatedBaseline, phase: { kind: 'ready' } });
    } catch (err) {
      set({
        baseline: updatedBaseline,
        phase: {
          kind: 'error',
          message: `${dirty.length} 件中 ${sent} 件目で保存が失敗しました: ${err}`,
        },
      });
    }
  },

  reloadFromDevice: async () => {
    const { transport, count } = get();
    if (!transport || count === 0) return;
    try {
      set({ phase: { kind: 'loading' } });
      const fetched = await fetchAllMorses(transport, count);
      set({ baseline: fetched, local: cloneEntries(fetched), phase: { kind: 'ready' } });
    } catch (err) {
      set({ phase: { kind: 'error', message: String(err) } });
    }
  },
}));

function setField(
  get: () => MorseEditorState,
  set: (partial: Partial<MorseEditorState>) => void,
  index: number,
  mapper: (e: MorseEntry) => MorseEntry,
): void {
  const { local } = get();
  if (!local[index]) return;
  const next = cloneEntries(local);
  next[index] = mapper(local[index]);
  set({ local: next });
}

// ─── Selectors ────────────────────────────────────────────────────────────

export function selectIsDirty(state: MorseEditorState): boolean {
  return dirtyIndices(state.baseline, state.local).length > 0;
}

export function selectDirtyMask(state: MorseEditorState): boolean[] {
  return state.local.map((entry, i) => {
    const base = state.baseline[i];
    return base ? !entriesEqual(base, entry) : false;
  });
}

export type MorseWarning = 'out-of-range' | 'no-op';

/**
 * Per-entry advisories. The firmware doesn't reject out-of-range
 * values — too short a tap term makes hold unreachable, too long
 * makes hold feel "stuck". A no-op entry (every keycode zero) is
 * legal but pointless.
 */
export function selectWarnings(state: MorseEditorState): Array<MorseWarning[]> {
  return state.local.map((entry) => {
    const warnings: MorseWarning[] = [];
    if (entry.tapTermMs < MIN_TAP_TERM_MS || entry.tapTermMs > MAX_TAP_TERM_MS) {
      warnings.push('out-of-range');
    }
    if (entry.tap === 0 && entry.hold === 0 && entry.doubleTap === 0 && entry.holdAfterTap === 0) {
      warnings.push('no-op');
    }
    return warnings;
  });
}

// ─── Built-in presets ─────────────────────────────────────────────────────

/**
 * One-click templates for common tap-dance patterns. Each builder
 * preserves whatever fields the user already had set (e.g. tap term
 * is kept) and only overwrites what the template defines.
 */
export const MORSE_PRESETS: readonly MorsePreset[] = [
  {
    name: 'タップ→Esc / 長押し→Ctrl',
    description: '英字キー (current tap) を維持しつつ、長押しで LCtrl、二度押しで Esc。',
    build: (e) => ({
      ...e,
      hold: 0x00e0, // LCtrl
      doubleTap: 0x0029, // Esc
    }),
  },
  {
    name: '括弧ペア (())',
    description: 'タップで `(`、ホールドで `)` を送出するシンプルなペア。',
    build: (e) => ({
      ...e,
      tap: 0x202f, // ShiftPause = (
      hold: 0x2030, // ShiftEqual = )
    }),
  },
  {
    name: 'クリア (No-op)',
    description: '全てのアクションをクリアします。',
    build: () => emptyMorse(),
  },
] as const;
