/**
 * Build-time settings store + the "edit → GitHub Actions build → flash"
 * flow. Knob values live here; `startBuild` dispatches a parameterised
 * firmware build, polls it to completion, downloads + unzips the
 * artifact, and `flash` writes a chosen UF2 to the bootloader.
 */

import { create } from 'zustand';
import { fetchArtifactUf2s, getBuildStatus, postBuild } from '../config/build';
import { changedCount, SETTING_DEFAULTS, toOverrides } from '../config/settings';
import { flashBytes, InstallError, type InstallProgress } from '../install/run';

const POLL_INTERVAL_MS = 6000;
const MAX_POLLS = 60; // ~6 minutes

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type BuildState =
  | { kind: 'idle' }
  | { kind: 'dispatching' }
  | { kind: 'building'; buildId: string; status: string; polls: number }
  | { kind: 'built'; files: Record<string, Uint8Array> }
  | { kind: 'flashing'; progress: InstallProgress }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

interface BuildSettingsStore {
  values: Record<string, number>;
  build: BuildState;
  setValue: (id: string, v: number) => void;
  resetAll: () => void;
  changed: () => number;
  startBuild: () => Promise<void>;
  flash: (asset: string) => Promise<void>;
  resetBuild: () => void;
}

export const useBuildSettingsStore = create<BuildSettingsStore>((set, get) => ({
  values: { ...SETTING_DEFAULTS },
  build: { kind: 'idle' },

  setValue: (id, v) => set((s) => ({ values: { ...s.values, [id]: v } })),
  resetAll: () => set({ values: { ...SETTING_DEFAULTS } }),
  changed: () => changedCount(get().values),
  resetBuild: () => set({ build: { kind: 'idle' } }),

  startBuild: async () => {
    const overrides = toOverrides(get().values);
    if (Object.keys(overrides).length === 0) {
      set({
        build: { kind: 'error', message: '変更がありません。スライダーを調整してください。' },
      });
      return;
    }
    set({ build: { kind: 'dispatching' } });
    const d = await postBuild(overrides);
    if (!d.ok || !d.buildId) {
      set({ build: { kind: 'error', message: d.error ?? 'ビルドを開始できませんでした。' } });
      return;
    }
    const buildId = d.buildId;
    set({ build: { kind: 'building', buildId, status: 'queued', polls: 0 } });

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const cur = get().build;
      if (cur.kind !== 'building' || cur.buildId !== buildId) return; // superseded
      const s = await getBuildStatus(buildId);
      set({ build: { kind: 'building', buildId, status: s.status, polls: i + 1 } });
      if (s.status === 'completed') {
        if (s.conclusion === 'success' && s.runId !== undefined) {
          try {
            const files = await fetchArtifactUf2s(s.runId);
            set({ build: { kind: 'built', files } });
          } catch (err) {
            set({
              build: { kind: 'error', message: err instanceof Error ? err.message : String(err) },
            });
          }
        } else {
          set({
            build: {
              kind: 'error',
              message: `ビルドが失敗しました（${s.conclusion ?? '不明'}）。`,
            },
          });
        }
        return;
      }
    }
    set({
      build: {
        kind: 'error',
        message: 'ビルドがタイムアウトしました。GitHub Actions を確認してください。',
      },
    });
  },

  flash: async (asset) => {
    const cur = get().build;
    if (cur.kind !== 'built') return;
    const bytes = cur.files[asset];
    if (!bytes) {
      set({ build: { kind: 'error', message: `${asset} がビルド成果物に含まれていません。` } });
      return;
    }
    const files = cur.files;
    set({ build: { kind: 'flashing', progress: { step: 'picking' } } });
    try {
      await flashBytes(bytes, asset, (progress) => set({ build: { kind: 'flashing', progress } }));
      set({ build: { kind: 'done' } });
    } catch (err) {
      if (err instanceof InstallError && err.kind === 'picker-cancelled') {
        set({ build: { kind: 'built', files } });
        return;
      }
      set({ build: { kind: 'error', message: err instanceof Error ? err.message : String(err) } });
    }
  },
}));
