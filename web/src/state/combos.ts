/**
 * Combo store: baseline-vs-local diff over N combo entries.
 *
 * Same shape as `state/macros.ts` and `state/editor.ts`. Combos are
 * fetched one entry at a time (`Vial / DynamicEntryOp / ComboGet`)
 * and saved the same way — there is no batch path on the wire.
 *
 * "Disabled" semantics: a combo with all-zero inputs AND all-zero
 * output is treated as unused by the firmware. The store keeps the
 * slot but the UI surfaces it as empty / "+ add".
 *
 * Save flow:
 *   1. confirm unlock (same gate the keymap and macro stores use)
 *   2. issue `ComboSet` for every dirty slot in order
 *   3. on each success, advance the baseline so a mid-flight failure
 *      leaves the device + UI in sync for the entries that already
 *      landed (RMK persists each entry independently)
 */

import { create } from 'zustand';
import {
  emptyCombo,
  entriesEqual,
  fetchAllCombos,
  fetchDynamicEntryCounts,
  setCombo,
} from '../protocol/combos';
import type { ComboEntry } from '../protocol/commands';
import { fetchUnlockStatus } from '../protocol/unlock';
import type { WebHidTransport } from '../transport/webhid';

export type ComboEditorPhase =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving'; sent: number; total: number }
  | { kind: 'error'; message: string };

export interface ComboEditorState {
  phase: ComboEditorPhase;
  transport: WebHidTransport | null;
  count: number;
  baseline: ComboEntry[];
  local: ComboEntry[];

  attach: (transport: WebHidTransport) => Promise<void>;
  detach: () => void;
  updateCombo: (index: number, entry: ComboEntry) => void;
  setInput: (index: number, slot: number, keycode: number) => void;
  setOutput: (index: number, keycode: number) => void;
  clearCombo: (index: number) => void;
  resetCombo: (index: number) => void;
  save: () => Promise<void>;
  reloadFromDevice: () => Promise<void>;
}

function cloneEntries(entries: ComboEntry[]): ComboEntry[] {
  return entries.map((e) => ({
    inputs: [e.inputs[0], e.inputs[1], e.inputs[2], e.inputs[3]],
    output: e.output,
  }));
}

function dirtyIndices(baseline: ComboEntry[], local: ComboEntry[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < local.length; i++) {
    const b = baseline[i];
    const l = local[i];
    if (!b || !l) continue;
    if (!entriesEqual(b, l)) out.push(i);
  }
  return out;
}

export const useComboStore = create<ComboEditorState>((set, get) => ({
  phase: { kind: 'empty' },
  transport: null,
  count: 0,
  baseline: [],
  local: [],

  attach: async (transport) => {
    set({ phase: { kind: 'loading' }, transport, baseline: [], local: [] });
    try {
      const counts = await fetchDynamicEntryCounts(transport);
      // kobu's `combo_max_num` is 16 — but trust the firmware so the
      // store stays correct if upstream RMK changes the cap.
      const fetched = await fetchAllCombos(transport, counts.combo);
      set({
        count: counts.combo,
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

  updateCombo: (index, entry) => {
    const { local } = get();
    if (!local[index]) return;
    const next = cloneEntries(local);
    next[index] = {
      inputs: [entry.inputs[0], entry.inputs[1], entry.inputs[2], entry.inputs[3]],
      output: entry.output,
    };
    set({ local: next });
  },

  setInput: (index, slot, keycode) => {
    const { local } = get();
    const entry = local[index];
    if (!entry || slot < 0 || slot > 3) return;
    const next = cloneEntries(local);
    const target = next[index];
    if (!target) return;
    target.inputs[slot as 0 | 1 | 2 | 3] = keycode;
    set({ local: next });
  },

  setOutput: (index, keycode) => {
    const { local } = get();
    if (!local[index]) return;
    const next = cloneEntries(local);
    const target = next[index];
    if (!target) return;
    target.output = keycode;
    set({ local: next });
  },

  clearCombo: (index) => {
    const { local } = get();
    if (!local[index]) return;
    const next = cloneEntries(local);
    next[index] = emptyCombo();
    set({ local: next });
  },

  resetCombo: (index) => {
    const { local, baseline } = get();
    const base = baseline[index];
    if (!local[index] || !base) return;
    const next = cloneEntries(local);
    next[index] = {
      inputs: [base.inputs[0], base.inputs[1], base.inputs[2], base.inputs[3]],
      output: base.output,
    };
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
        await setCombo(transport, idx, value);
        const slot = updatedBaseline[idx];
        if (slot) {
          slot.inputs = [value.inputs[0], value.inputs[1], value.inputs[2], value.inputs[3]];
          slot.output = value.output;
        }
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
      const fetched = await fetchAllCombos(transport, count);
      set({ baseline: fetched, local: cloneEntries(fetched), phase: { kind: 'ready' } });
    } catch (err) {
      set({ phase: { kind: 'error', message: String(err) } });
    }
  },
}));

// ─── Selectors ────────────────────────────────────────────────────────────

export function selectIsDirty(state: ComboEditorState): boolean {
  return dirtyIndices(state.baseline, state.local).length > 0;
}

export function selectDirtyMask(state: ComboEditorState): boolean[] {
  return state.local.map((entry, i) => {
    const base = state.baseline[i];
    return base ? !entriesEqual(base, entry) : false;
  });
}

/**
 * Detect duplicate-input combos. Two combos with the same set of
 * non-zero input keycodes (order-independent) will fire each other —
 * the firmware will only honour one. Empty entries are excluded.
 *
 * Returns the indices that participate in a duplicate.
 */
export function selectDuplicateIndices(state: ComboEditorState): Set<number> {
  const seen = new Map<string, number[]>();
  for (let i = 0; i < state.local.length; i++) {
    const entry = state.local[i];
    if (!entry) continue;
    const nonZero = entry.inputs.filter((k) => k !== 0).sort((a, b) => a - b);
    if (nonZero.length === 0) continue;
    const key = nonZero.join(',');
    const list = seen.get(key) ?? [];
    list.push(i);
    seen.set(key, list);
  }
  const dups = new Set<number>();
  for (const list of seen.values()) {
    if (list.length > 1) for (const i of list) dups.add(i);
  }
  return dups;
}
