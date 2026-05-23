/**
 * kobu-specific settings store (trackball / scroll / status-LED).
 *
 * Talks the QMK Via Custom Value channel from
 * `protocol/customValue.ts`. Same baseline-vs-local pattern as the
 * other editors so the user can preview a slider then revert without
 * a save round-trip.
 *
 * Writes are debounced — sliders fire many events per second and we
 * don't want one round-trip per pixel. The store collects pending
 * writes per-slot and flushes 150 ms after the last edit.
 *
 * ⚠ The firmware-side handler is not yet wired up (see #39's
 * "Deferred" section). Until it lands, writes succeed on the wire
 * (RMK's stub handler ack'd them) but the values are not persisted.
 * The UI surfaces a static "開発中の機能" banner explaining this so
 * users aren't blindsided when a setting doesn't survive a reboot.
 */

import { create } from 'zustand';
import {
  fetchKobuSettings,
  KOBU_VALUES,
  type KobuSettingKey,
  setKobuValue,
  type ValueDef,
} from '../protocol/customValue';
import type { WebHidTransport } from '../transport/webhid';

const DEBOUNCE_MS = 150;

export type KobuSettingsPhase =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export type KobuSettingsMap = Record<KobuSettingKey, number>;

export interface KobuSettingsState {
  phase: KobuSettingsPhase;
  transport: WebHidTransport | null;
  /** Last server-acknowledged values. */
  baseline: KobuSettingsMap;
  /** In-memory edits, including unsaved slider drags. */
  local: KobuSettingsMap;

  attach: (transport: WebHidTransport) => Promise<void>;
  detach: () => void;
  setValue: (key: KobuSettingKey, value: number) => void;
  resetCategory: (keys: readonly KobuSettingKey[]) => void;
  resetAll: () => void;
  reloadFromDevice: () => Promise<void>;
}

function defaultMap(): KobuSettingsMap {
  const out = {} as KobuSettingsMap;
  for (const def of KOBU_VALUES) {
    out[def.key] = def.default;
  }
  return out;
}

function findDef(key: KobuSettingKey): ValueDef | undefined {
  return KOBU_VALUES.find((v) => v.key === key);
}

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
}

const pending: Partial<Record<KobuSettingKey, PendingWrite>> = {};

export const useKobuSettingsStore = create<KobuSettingsState>((set, get) => ({
  phase: { kind: 'empty' },
  transport: null,
  baseline: defaultMap(),
  local: defaultMap(),

  attach: async (transport) => {
    set({
      phase: { kind: 'loading' },
      transport,
      baseline: defaultMap(),
      local: defaultMap(),
    });
    try {
      const settings = await fetchKobuSettings(transport);
      set({
        baseline: settings,
        local: { ...settings },
        phase: { kind: 'ready' },
      });
    } catch (err) {
      set({ phase: { kind: 'error', message: String(err) } });
    }
  },

  detach: () => {
    for (const slot of Object.values(pending)) {
      if (slot) clearTimeout(slot.timer);
    }
    for (const k of Object.keys(pending)) {
      delete pending[k as KobuSettingKey];
    }
    set({
      phase: { kind: 'empty' },
      transport: null,
      baseline: defaultMap(),
      local: defaultMap(),
    });
  },

  setValue: (key, value) => {
    const def = findDef(key);
    if (!def) return;
    const clamped = Math.max(def.min, Math.min(def.max, value | 0));
    const next = { ...get().local, [key]: clamped };
    set({ local: next });

    // Debounce per-slot — successive drags on the same slider replace
    // the pending write rather than queueing one per pixel.
    const existing = pending[key];
    if (existing) clearTimeout(existing.timer);
    const transport = get().transport;
    if (!transport) return;
    pending[key] = {
      timer: setTimeout(async () => {
        delete pending[key];
        try {
          await setKobuValue(transport, def, clamped);
          set((state) => ({
            baseline: { ...state.baseline, [key]: clamped },
          }));
        } catch (err) {
          set({ phase: { kind: 'error', message: `${key} の書き込みに失敗しました: ${err}` } });
        }
      }, DEBOUNCE_MS),
    };
  },

  resetCategory: (keys) => {
    for (const key of keys) {
      const def = findDef(key);
      if (def) get().setValue(key, def.default);
    }
  },

  resetAll: () => {
    for (const def of KOBU_VALUES) {
      get().setValue(def.key, def.default);
    }
  },

  reloadFromDevice: async () => {
    const { transport } = get();
    if (!transport) return;
    try {
      set({ phase: { kind: 'loading' } });
      const settings = await fetchKobuSettings(transport);
      set({
        baseline: settings,
        local: { ...settings },
        phase: { kind: 'ready' },
      });
    } catch (err) {
      set({ phase: { kind: 'error', message: String(err) } });
    }
  },
}));

// ─── Categorisation helpers (UI uses these) ──────────────────────────

export const TRACKBALL_KEYS: readonly KobuSettingKey[] = ['trackball_cpi'];
export const SCROLL_KEYS: readonly KobuSettingKey[] = [
  'scroll_throttle_ms',
  'scroll_invert_x',
  'scroll_invert_y',
];
export const STATUS_LED_KEYS: readonly KobuSettingKey[] = [
  'status_led_purple_hold_ms',
  'status_led_battery_high_threshold',
  'status_led_battery_low_threshold',
];
