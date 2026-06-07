/**
 * Unlock state machine — the interactive front-end for `protocol/unlock`.
 *
 * Vial firmwares refuse keymap/macro/combo/morse/setting writes until the
 * user proves physical possession by holding a key chord (kobu: both outer
 * pinkies) for ~5 s. The protocol layer (`performUnlock`/`lock`/
 * `fetchUnlockStatus`) was fully implemented and tested but had no UI driving
 * it — every save flow could only *gate* on `fetchUnlockStatus().locked` and
 * dead-end with a "device is locked" string. This store is the missing piece:
 * it tracks lock state, drives `performUnlock` with a live countdown, exposes
 * the chord cells so the keymap can highlight which keys to hold, and lets the
 * user re-lock. It is the single source of truth the `UnlockPanel` renders and
 * the keymap view highlights from.
 *
 * Shape mirrors the other feature stores: `attach(transport)` on connect
 * (which eagerly refreshes status so the lock banner appears immediately),
 * `detach()` on disconnect (which aborts any in-flight unlock).
 */

import { create } from 'zustand';
import { fetchUnlockStatus, lock, performUnlock } from '../protocol/unlock';
import type { WebHidTransport } from '../transport/webhid';

export type UnlockPhase = 'unknown' | 'locked' | 'unlocking' | 'unlocked';

export interface ChordCell {
  row: number;
  col: number;
}

interface UnlockStore {
  transport: WebHidTransport | null;
  status: UnlockPhase;
  /** Physical (row, col) keys that make up the unlock chord, from the firmware. */
  chord: ChordCell[];
  /** Firmware countdown remaining in the active attempt (decrements only while the chord is held). */
  remaining: number;
  /** First countdown value observed this attempt, for the progress bar denominator. */
  total: number;
  error: string | null;
  /** Internal: cancels an in-flight `performUnlock`. */
  _abort: AbortController | null;

  attach: (transport: WebHidTransport) => Promise<void>;
  detach: () => void;
  /** Re-read lock state + chord from the firmware. */
  refresh: () => Promise<void>;
  /** Drive the full hold-the-chord unlock with a live countdown. */
  beginUnlock: () => Promise<void>;
  /** Abort an in-flight unlock attempt. */
  cancel: () => void;
  /** Re-engage the firmware lock. */
  relock: () => Promise<void>;
}

const RESET = {
  status: 'unknown' as UnlockPhase,
  chord: [] as ChordCell[],
  remaining: 0,
  total: 0,
  error: null as string | null,
  _abort: null as AbortController | null,
};

export const useUnlockStore = create<UnlockStore>((set, get) => ({
  transport: null,
  ...RESET,

  attach: async (transport) => {
    get()._abort?.abort();
    set({ transport, ...RESET });
    await get().refresh();
  },

  detach: () => {
    get()._abort?.abort();
    set({ transport: null, ...RESET });
  },

  refresh: async () => {
    const { transport } = get();
    if (!transport) return;
    try {
      const status = await fetchUnlockStatus(transport);
      // Don't clobber an in-flight unlock attempt with a stale "locked".
      if (get().status === 'unlocking') return;
      set({ status: status.locked ? 'locked' : 'unlocked', chord: status.chord, error: null });
    } catch (err) {
      set({ error: `アンロック状態の取得に失敗しました: ${err}` });
    }
  },

  beginUnlock: async () => {
    const { transport, status } = get();
    if (!transport || status === 'unlocking') return;
    const abort = new AbortController();
    set({ status: 'unlocking', remaining: 0, total: 0, error: null, _abort: abort });
    try {
      await performUnlock(transport, {
        signal: abort.signal,
        onTick: (result) => {
          set((s) => ({
            remaining: result.remaining,
            // Latch the starting count the first time we see a non-zero value.
            total: s.total > 0 ? s.total : Math.max(result.remaining, 1),
          }));
        },
      });
      set({ status: 'unlocked', remaining: 0, _abort: null, error: null });
      await get().refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const error =
        msg === 'cancelled'
          ? null
          : msg === 'unlock-timeout'
            ? 'アンロックがタイムアウトしました。コードを押し続けながらもう一度お試しください。'
            : `アンロックに失敗しました: ${msg}`;
      set({ status: 'locked', remaining: 0, total: 0, _abort: null, error });
    }
  },

  cancel: () => {
    // beginUnlock's catch transitions back to 'locked' when the abort fires.
    get()._abort?.abort();
  },

  relock: async () => {
    const { transport } = get();
    if (!transport) return;
    try {
      await lock(transport);
    } catch {
      // Best-effort; refresh reflects the real state regardless.
    }
    await get().refresh();
  },
}));
