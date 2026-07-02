/**
 * Editor state: layers, the baseline-vs-local keymap diff, selection,
 * undo/redo, and the save flow.
 *
 * The store is independent of the connection store on purpose — the
 * editor cares about a `WebHidTransport` + `KeyboardLayoutDef` regardless
 * of *how* they were acquired (real device today, mocked replay
 * tomorrow). The UI wires the two together at the boundary.
 *
 * Dirty model:
 *   * `baseline`  the last keymap we read from / wrote to firmware
 *   * `local`     the in-memory edited copy
 *   * a cell is "dirty" when local[L][R][C] !== baseline[L][R][C]
 *
 * Save flow (Phase 3.2 spec):
 *   1. confirm unlock; bail with an error if locked
 *   2. for every dirty cell, send DynamicKeymapSetKeyCode
 *   3. after each successful write, mark that cell as baseline=local
 *      (so a mid-flight failure still leaves the device + UI in sync
 *      with the cells that already landed)
 *   4. on completion drop the undo stack so further edits start a new
 *      diff against the freshly-saved baseline
 */

import { create } from 'zustand';
import { describeWriteError, isTransportLost } from '../lib/saveError';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import {
  fetchKeymap,
  fetchLayerCount,
  type Keymap,
  type KeymapDimensions,
  resetKeymap,
  setKeycode,
} from '../protocol/keymap';
import { fetchUnlockStatus } from '../protocol/unlock';
import type { WebHidTransport } from '../transport/webhid';

export interface EditPosition {
  layer: number;
  row: number;
  col: number;
}

interface PendingEdit {
  position: EditPosition;
  before: number;
  after: number;
}

export type EditorPhase =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving'; sent: number; total: number }
  | { kind: 'error'; message: string };

export interface EditorState {
  phase: EditorPhase;
  transport: WebHidTransport | null;
  definition: KeyboardLayoutDef | null;
  dimensions: KeymapDimensions | null;
  baseline: Keymap | null;
  local: Keymap | null;
  activeLayer: number;
  selected: EditPosition | null;
  undoStack: PendingEdit[];
  redoStack: PendingEdit[];

  // ── actions ────────────────────────────────────────────────────────────
  attach: (transport: WebHidTransport, definition: KeyboardLayoutDef) => Promise<void>;
  detach: () => void;
  setActiveLayer: (layer: number) => void;
  selectCell: (position: EditPosition | null) => void;
  setKey: (position: EditPosition, keycode: number) => void;
  applyKeyToSelection: (keycode: number) => void;
  resetSelectionToBaseline: () => void;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;
  /** Drop the local-only edits and re-sync from the device. */
  reloadFromDevice: () => Promise<void>;
  /**
   * Tell the firmware to wipe the dynamic keymap back to its
   * build-time defaults, then re-read the keymap from the device so
   * the editor reflects the new baseline. Macros / combos / morses
   * are NOT touched — this is a layer-keymap-only reset.
   */
  resetToDefault: () => Promise<void>;
}

function cloneKeymap(km: Keymap): Keymap {
  return km.map((layer) => layer.map((row) => row.slice()));
}

function isDirty(baseline: Keymap | null, local: Keymap | null, position: EditPosition): boolean {
  if (!baseline || !local) return false;
  return (
    baseline[position.layer]?.[position.row]?.[position.col] !==
    local[position.layer]?.[position.row]?.[position.col]
  );
}

function collectDirtyCells(baseline: Keymap, local: Keymap): EditPosition[] {
  const out: EditPosition[] = [];
  for (let layer = 0; layer < local.length; layer++) {
    const localLayer = local[layer];
    const baseLayer = baseline[layer];
    if (!localLayer || !baseLayer) continue;
    for (let row = 0; row < localLayer.length; row++) {
      const localRow = localLayer[row];
      const baseRow = baseLayer[row];
      if (!localRow || !baseRow) continue;
      for (let col = 0; col < localRow.length; col++) {
        if (localRow[col] !== baseRow[col]) {
          out.push({ layer, row, col });
        }
      }
    }
  }
  return out;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  phase: { kind: 'empty' },
  transport: null,
  definition: null,
  dimensions: null,
  baseline: null,
  local: null,
  activeLayer: 0,
  selected: null,
  undoStack: [],
  redoStack: [],

  attach: async (transport, definition) => {
    set({
      phase: { kind: 'loading' },
      transport,
      definition,
      baseline: null,
      local: null,
      undoStack: [],
      redoStack: [],
      selected: null,
      activeLayer: 0,
    });
    try {
      const layers = await fetchLayerCount(transport);
      const dim: KeymapDimensions = {
        layers,
        rows: definition.matrix.rows,
        cols: definition.matrix.cols,
      };
      const km = await fetchKeymap(transport, dim);
      set({
        dimensions: dim,
        baseline: km,
        local: cloneKeymap(km),
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
      definition: null,
      dimensions: null,
      baseline: null,
      local: null,
      activeLayer: 0,
      selected: null,
      undoStack: [],
      redoStack: [],
    });
  },

  setActiveLayer: (layer) => {
    const dim = get().dimensions;
    if (!dim) return;
    const clamped = Math.max(0, Math.min(layer, dim.layers - 1));
    set({ activeLayer: clamped, selected: null });
  },

  selectCell: (position) => {
    set({ selected: position });
  },

  setKey: (position, keycode) => {
    const { local, baseline } = get();
    if (!local || !baseline) return;
    const layer = local[position.layer];
    const row = layer?.[position.row];
    if (!layer || !row) return;
    const before = row[position.col] ?? 0;
    if (before === keycode) return;

    // Mutate in place — we always copy when crossing the store boundary.
    const newLocal = cloneKeymap(local);
    const newRow = newLocal[position.layer]?.[position.row];
    if (!newRow) return;
    newRow[position.col] = keycode;

    set((state) => ({
      local: newLocal,
      undoStack: [...state.undoStack, { position, before, after: keycode }],
      redoStack: [],
    }));
  },

  applyKeyToSelection: (keycode) => {
    const sel = get().selected;
    if (!sel) return;
    get().setKey(sel, keycode);
  },

  resetSelectionToBaseline: () => {
    const { selected, baseline } = get();
    if (!selected || !baseline) return;
    const baseValue = baseline[selected.layer]?.[selected.row]?.[selected.col];
    if (baseValue === undefined) return;
    get().setKey(selected, baseValue);
  },

  undo: () => {
    const state = get();
    const last = state.undoStack[state.undoStack.length - 1];
    if (!last || !state.local) return;
    const newLocal = cloneKeymap(state.local);
    const targetRow = newLocal[last.position.layer]?.[last.position.row];
    if (!targetRow) return;
    targetRow[last.position.col] = last.before;
    set({
      local: newLocal,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, last],
    });
  },

  redo: () => {
    const state = get();
    const next = state.redoStack[state.redoStack.length - 1];
    if (!next || !state.local) return;
    const newLocal = cloneKeymap(state.local);
    const targetRow = newLocal[next.position.layer]?.[next.position.row];
    if (!targetRow) return;
    targetRow[next.position.col] = next.after;
    set({
      local: newLocal,
      undoStack: [...state.undoStack, next],
      redoStack: state.redoStack.slice(0, -1),
    });
  },

  save: async () => {
    const { transport, baseline, local } = get();
    if (!transport || !baseline || !local) return;

    const dirty = collectDirtyCells(baseline, local);
    if (dirty.length === 0) return;

    // Refuse to start if the firmware is locked — vial-gui pops a prompt
    // here and so do we (via the UI; the store just reports the kind).
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

    const updatedBaseline = cloneKeymap(baseline);
    let sent = 0;
    try {
      for (const cell of dirty) {
        const value = local[cell.layer]?.[cell.row]?.[cell.col];
        if (value === undefined) continue;
        await setKeycode(transport, cell.layer, cell.row, cell.col, value);
        const row = updatedBaseline[cell.layer]?.[cell.row];
        if (row) row[cell.col] = value;
        sent++;
        set({ phase: { kind: 'saving', sent, total: dirty.length } });
      }
    } catch (err) {
      // A write itself failed mid-loop. Keep the writes that DID land in the
      // baseline (firmware persists each SetKeyCode immediately), surface the
      // failure, and leave the rest of the local edits dirty for retry.
      set({
        baseline: updatedBaseline,
        phase: {
          kind: 'error',
          message: isTransportLost(err)
            ? describeWriteError(err)
            : `${dirty.length} 件中 ${sent} 件目で保存が失敗しました: ${describeWriteError(err)}`,
        },
      });
      return;
    }

    // All writes were issued without error. Verify the firmware stayed unlocked
    // through the whole loop — RMK SILENTLY ignores SetKeyCode while locked (no
    // error), so a lock that engaged mid-save would have dropped writes while
    // every call "succeeded". This runs in its OWN try: if the verification
    // probe itself fails (e.g. transport lost just after the loop), we must NOT
    // advance the baseline — the writes are unverified, so we keep everything
    // dirty so the user can reconnect and retry rather than silently lose edits.
    try {
      const after = await fetchUnlockStatus(transport);
      if (after.locked) {
        set({
          phase: {
            kind: 'error',
            message:
              'デバイスがロックされたため、変更が反映されていない可能性があります。上のバナーからアンロックして再保存してください。',
          },
        });
        return;
      }
    } catch (err) {
      set({ phase: { kind: 'error', message: describeWriteError(err) } });
      return;
    }

    set({
      baseline: updatedBaseline,
      undoStack: [],
      redoStack: [],
      phase: { kind: 'ready' },
    });
  },

  reloadFromDevice: async () => {
    const { transport, dimensions } = get();
    if (!transport || !dimensions) return;
    try {
      set({ phase: { kind: 'loading' } });
      const km = await fetchKeymap(transport, dimensions);
      set({
        baseline: km,
        local: cloneKeymap(km),
        undoStack: [],
        redoStack: [],
        phase: { kind: 'ready' },
      });
    } catch (err) {
      set({ phase: { kind: 'error', message: String(err) } });
    }
  },

  resetToDefault: async () => {
    const { transport, dimensions } = get();
    if (!transport || !dimensions) return;
    // Surface the same locked-device error path as `save` — the
    // firmware silently ignores DynamicKeymapReset when locked, so we
    // check up-front instead of pretending the reset worked.
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
    try {
      set({ phase: { kind: 'loading' } });
      await resetKeymap(transport);
      const km = await fetchKeymap(transport, dimensions);
      set({
        baseline: km,
        local: cloneKeymap(km),
        undoStack: [],
        redoStack: [],
        selected: null,
        phase: { kind: 'ready' },
      });
    } catch (err) {
      set({ phase: { kind: 'error', message: `デフォルトへのリセットに失敗しました: ${err}` } });
    }
  },
}));

// ─── Selectors ────────────────────────────────────────────────────────────

/** True iff at least one cell on any layer differs from baseline. */
export function selectIsDirty(state: EditorState): boolean {
  if (!state.baseline || !state.local) return false;
  return collectDirtyCells(state.baseline, state.local).length > 0;
}

/** Bitmask: bit N set ⇒ layer N has at least one dirty cell. */
export function selectDirtyLayerMask(state: EditorState): number {
  if (!state.baseline || !state.local) return 0;
  let mask = 0;
  for (const cell of collectDirtyCells(state.baseline, state.local)) {
    mask |= 1 << cell.layer;
  }
  return mask;
}

export function isCellDirty(state: EditorState, position: EditPosition): boolean {
  return isDirty(state.baseline, state.local, position);
}
