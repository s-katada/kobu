/**
 * Macro store: baseline vs. local diff of N macro sequences, plus the
 * read/write transport orchestration.
 *
 * Mirrors the shape of the keymap editor store (`state/editor.ts`):
 *
 *   * `baseline`  the last buffer we successfully read from firmware
 *   * `local`     the in-memory edited copy as a list of action arrays
 *   * a macro is "dirty" when its encoded bytes differ from baseline
 *
 * Save flow:
 *   1. confirm unlock (re-uses the keymap editor's gate — the firmware
 *      rejects macro writes the same way as keymap writes)
 *   2. encode every local sequence into one buffer
 *   3. write the buffer in 28-byte chunks starting at offset 0
 *      (RMK 0.8 zeroes its cache on offset=0, so partial rewrites
 *      cannot start anywhere else)
 *   4. on success, baseline = local
 *
 * Unlike the keymap save flow we cannot resume mid-failure — RMK
 * zeroes the buffer on the first chunk, so a partial write leaves the
 * device in an inconsistent state. On failure we mark the phase as
 * `error` and leave both baseline and local untouched so the user can
 * retry.
 */

import { create } from 'zustand';
import {
  decodeBuffer,
  encodeBuffer,
  encodeSequence,
  fetchMacroBuffer,
  fetchMacroBufferSize,
  fetchMacroCount,
  type MacroAction,
  type MacroSequence,
  writeMacroBuffer,
} from '../protocol/macros';
import { fetchUnlockStatus } from '../protocol/unlock';
import type { WebHidTransport } from '../transport/webhid';

export type MacroEditorPhase =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving'; written: number; total: number }
  | { kind: 'error'; message: string };

export interface MacroEditorState {
  phase: MacroEditorPhase;
  transport: WebHidTransport | null;
  count: number;
  bufferSize: number;
  baseline: MacroSequence[];
  local: MacroSequence[];
  activeIndex: number;

  attach: (transport: WebHidTransport) => Promise<void>;
  detach: () => void;
  setActiveIndex: (index: number) => void;
  setMacro: (index: number, sequence: MacroSequence) => void;
  addAction: (index: number, action: MacroAction) => void;
  updateAction: (index: number, position: number, action: MacroAction) => void;
  removeAction: (index: number, position: number) => void;
  moveAction: (index: number, from: number, to: number) => void;
  resetMacro: (index: number) => void;
  save: () => Promise<void>;
  reloadFromDevice: () => Promise<void>;
}

function cloneSequences(seqs: MacroSequence[]): MacroSequence[] {
  return seqs.map((s) => s.map((a) => ({ ...a }) as MacroAction));
}

function isMacroDirty(
  baseline: MacroSequence | undefined,
  local: MacroSequence | undefined,
): boolean {
  if (!baseline || !local) return baseline !== local;
  if (baseline.length !== local.length) return true;
  const baseEnc = encodeSequence(baseline);
  const localEnc = encodeSequence(local);
  if (baseEnc.length !== localEnc.length) return true;
  for (let i = 0; i < baseEnc.length; i++) {
    if (baseEnc[i] !== localEnc[i]) return true;
  }
  return false;
}

/** Total bytes used by the current local sequences (incl. terminators). */
export function usedBytes(local: MacroSequence[]): number {
  let total = 0;
  for (const seq of local) {
    total += encodeSequence(seq).length + 1; // +1 for the 0x00 terminator
  }
  return total;
}

export const useMacroStore = create<MacroEditorState>((set, get) => ({
  phase: { kind: 'empty' },
  transport: null,
  count: 0,
  bufferSize: 0,
  baseline: [],
  local: [],
  activeIndex: 0,

  attach: async (transport) => {
    set({
      phase: { kind: 'loading' },
      transport,
      baseline: [],
      local: [],
      activeIndex: 0,
    });
    try {
      const count = await fetchMacroCount(transport);
      const bufferSize = await fetchMacroBufferSize(transport);
      const raw = await fetchMacroBuffer(transport, bufferSize);
      const decoded = decodeBuffer(raw, count);
      set({
        count,
        bufferSize,
        baseline: decoded,
        local: cloneSequences(decoded),
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
      bufferSize: 0,
      baseline: [],
      local: [],
      activeIndex: 0,
    });
  },

  setActiveIndex: (index) => {
    const { count } = get();
    if (count === 0) return;
    set({ activeIndex: Math.max(0, Math.min(index, count - 1)) });
  },

  setMacro: (index, sequence) => {
    const { local } = get();
    if (!local[index]) return;
    const next = cloneSequences(local);
    next[index] = sequence.map((a) => ({ ...a }) as MacroAction);
    set({ local: next });
  },

  addAction: (index, action) => {
    const { local } = get();
    const seq = local[index];
    if (!seq) return;
    const next = cloneSequences(local);
    next[index] = [...seq, { ...action } as MacroAction];
    set({ local: next });
  },

  updateAction: (index, position, action) => {
    const { local } = get();
    const seq = local[index];
    if (!seq?.[position]) return;
    const next = cloneSequences(local);
    const nextSeq = [...seq];
    nextSeq[position] = { ...action } as MacroAction;
    next[index] = nextSeq;
    set({ local: next });
  },

  removeAction: (index, position) => {
    const { local } = get();
    const seq = local[index];
    if (!seq || position < 0 || position >= seq.length) return;
    const next = cloneSequences(local);
    next[index] = seq.filter((_, i) => i !== position);
    set({ local: next });
  },

  moveAction: (index, from, to) => {
    const { local } = get();
    const seq = local[index];
    if (!seq) return;
    if (from < 0 || from >= seq.length) return;
    const clampedTo = Math.max(0, Math.min(to, seq.length - 1));
    if (from === clampedTo) return;
    const next = cloneSequences(local);
    const reordered = [...seq];
    const [moved] = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(clampedTo, 0, moved);
    next[index] = reordered;
    set({ local: next });
  },

  resetMacro: (index) => {
    const { local, baseline } = get();
    if (!local[index] || !baseline[index]) return;
    const next = cloneSequences(local);
    next[index] = baseline[index].map((a) => ({ ...a }) as MacroAction);
    set({ local: next });
  },

  save: async () => {
    const { transport, local, bufferSize } = get();
    if (!transport || bufferSize === 0) return;

    let encoded: Uint8Array;
    try {
      encoded = encodeBuffer(local, bufferSize);
    } catch (err) {
      set({
        phase: {
          kind: 'error',
          message: `マクロバッファのサイズを超えました（${bufferSize} B）: ${err}`,
        },
      });
      return;
    }

    // Re-use the keymap save's unlock gate — RMK enforces unlock for
    // macro writes the same way it does for keymap writes.
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

    set({ phase: { kind: 'saving', written: 0, total: encoded.length } });
    try {
      await writeMacroBuffer(transport, encoded, (written, total) => {
        set({ phase: { kind: 'saving', written, total } });
      });
      set({
        baseline: cloneSequences(local),
        phase: { kind: 'ready' },
      });
    } catch (err) {
      set({
        phase: {
          kind: 'error',
          // RMK zeroes its cache on offset=0 then writes incrementally,
          // so a failure mid-flight may leave the device with partial
          // macros. Surface this explicitly so users know to retry
          // before unplugging.
          message: `マクロの保存に失敗しました。デバイスの状態が不整合の可能性があります。再保存してください: ${err}`,
        },
      });
    }
  },

  reloadFromDevice: async () => {
    const { transport, count, bufferSize } = get();
    if (!transport || bufferSize === 0) return;
    try {
      set({ phase: { kind: 'loading' } });
      const raw = await fetchMacroBuffer(transport, bufferSize);
      const decoded = decodeBuffer(raw, count);
      set({
        baseline: decoded,
        local: cloneSequences(decoded),
        phase: { kind: 'ready' },
      });
    } catch (err) {
      set({ phase: { kind: 'error', message: String(err) } });
    }
  },
}));

// ─── Selectors ────────────────────────────────────────────────────────────

export function selectIsDirty(state: MacroEditorState): boolean {
  for (let i = 0; i < state.local.length; i++) {
    if (isMacroDirty(state.baseline[i], state.local[i])) return true;
  }
  return false;
}

export function selectDirtyMask(state: MacroEditorState): boolean[] {
  return state.local.map((seq, i) => isMacroDirty(state.baseline[i], seq));
}

export function selectUsedBytes(state: MacroEditorState): number {
  return usedBytes(state.local);
}
