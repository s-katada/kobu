/**
 * Self-contained install flow for one UF2 asset.
 *
 * Two modes:
 *
 *   * `preserve` (default) — single-stage. RESET (auto or manual) →
 *     pick XIAO-BOOT → write the normal `*.uf2`. RMK's storage region
 *     is untouched, so the user's customised keymap survives.
 *
 *   * `clean` — two-stage. RMK 0.8 doesn't implement the Via
 *     DynamicKeymapReset command (the handler is a no-op), so we
 *     can't wipe the keymap via the wire protocol. Instead we ship a
 *     second build of the firmware with `clear_layout = true` in
 *     keyboard.toml's [storage] section:
 *
 *       Stage 1: flash `*-reset.uf2`. On boot the firmware clears the
 *                layout region (BLE bonds survive).
 *       Stage 2: flash the normal `*.uf2`. The device boots with an
 *                empty storage and the build-time default keymap;
 *                future customisations persist.
 *
 * **Auto-bootloader-jump** (when `target === 'central'` and the
 * connection store is `ready`): we send Vial `BootloaderJump` instead
 * of telling the user to tap RESET. The firmware reboots into the
 * UF2 mass-storage bootloader on its own. Peripheral and
 * disconnected-central installs fall back to the physical-RESET
 * wizard.
 *
 * **Saved-directory shortcut**: the first XIAO-BOOT directory the
 * user picks gets stashed in IndexedDB. Subsequent installs probe
 * the saved handle (permission still granted, volume still mounted)
 * and skip the picker entirely.
 *
 * Chromium 系で File System Access API が無い場合は導線を畳んで
 * 「uf2 をダウンロード」リンクへの案内に切り替える。
 */

import { useCallback, useState } from 'react';
import {
  InstallError,
  isFileSystemAccessSupported,
  pickXiaoBoot,
  writeUf2,
} from '../install/filesystem';
import {
  isHandleAccessible,
  loadXiaoBootHandle,
  queryHandlePermission,
  requestHandlePermission,
  saveXiaoBootHandle,
} from '../install/handleStore';
import { fetchUf2, verifyXiaoBootDirectory } from '../install/install';
import { enterBootloader } from '../protocol/device';
import { useConnectionStore } from '../state/connection';
import type { FirmwareAsset } from '../state/firmware';
import type { WebHidTransport } from '../transport/webhid';

export type InstallMode = 'preserve' | 'clean';

export type InstallTarget = 'central' | 'peripheral';

export interface InstallButtonProps {
  /** UI label, e.g. "セントラル (左半分)". */
  label: string;
  /** Normal firmware asset (download URL + filename). */
  asset: FirmwareAsset;
  /**
   * `preserve` (default) — flash the normal uf2, keep user keymap.
   * `clean` — first flash `resetAsset`, then flash `asset`.
   */
  mode?: InstallMode;
  /**
   * Required when `mode === 'clean'`: the `*-reset.uf2` variant that
   * flips `clear_layout = true`. If omitted on a clean install, the
   * UI surfaces an error explaining the missing asset.
   */
  resetAsset?: FirmwareAsset;
  /**
   * Which half this installer targets. Setting to `'central'` enables
   * the auto-bootloader-jump path when a Vial connection is open;
   * `'peripheral'` (and the unset default) always uses the manual
   * RESET wizard since peripheral has no Vial endpoint.
   */
  target?: InstallTarget;
  /**
   * Override how long to wait for OS XIAO-BOOT mount after sending
   * Vial BootloaderJump. Default is `MOUNT_WAIT_MS` (3000 ms); tests
   * set it to 0 to skip the real-time wait.
   */
  mountWaitMs?: number;
}

type Stage = 'reset' | 'normal';

/** Why we landed on the "pick XIAO-BOOT" step. Drives wizard copy. */
type ReadyReason = 'auto-jumped' | 'physical-reset';

type Phase =
  | { kind: 'idle' }
  | { kind: 'jumping-to-bootloader'; stage: Stage }
  | { kind: 'waiting-for-mount'; stage: Stage }
  | { kind: 'awaiting-physical-reset'; stage: Stage }
  | { kind: 'ready-to-pick'; stage: Stage; reason: ReadyReason }
  | { kind: 'picking'; stage: Stage }
  | { kind: 'verifying'; stage: Stage; dir: FileSystemDirectoryHandle }
  | {
      kind: 'fetching';
      stage: Stage;
      dir: FileSystemDirectoryHandle;
      loaded: number;
      total: number | null;
    }
  | { kind: 'writing'; stage: Stage; dir: FileSystemDirectoryHandle }
  | { kind: 'stage1-done' }
  | { kind: 'done' }
  | { kind: 'error'; message: string; resumeStage: Stage };

/**
 * How long to wait for the OS to surface the XIAO-BOOT mass-storage
 * volume after BootloaderJump. The XIAO BLE typically reboots and
 * enumerates within ~1.5 s; 3 s gives the file picker something to
 * latch onto without making the user stare at a spinner.
 */
const MOUNT_WAIT_MS = 3000;

export function InstallButton({
  label,
  asset,
  mode = 'preserve',
  resetAsset,
  target,
  mountWaitMs = MOUNT_WAIT_MS,
}: InstallButtonProps) {
  const supported = isFileSystemAccessSupported();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const connection = useConnectionStore((s) => s.state);

  const close = useCallback(() => setPhase({ kind: 'idle' }), []);

  const assetForStage = (stage: Stage): FirmwareAsset | undefined =>
    stage === 'reset' ? resetAsset : asset;

  /**
   * Return the Vial transport if we can use it for an auto-jump on
   * this install. Central + ready = yes; everything else = no
   * (peripheral has no Vial endpoint; a non-ready central means we
   * couldn't talk to it anyway).
   */
  const autoJumpTransport = (): WebHidTransport | null => {
    if (target !== 'central') return null;
    if (connection.kind !== 'ready') return null;
    return connection.transport;
  };

  /**
   * Probe a saved directory handle. Returns the handle if the user's
   * still-granted permission AND the volume is currently mounted —
   * suitable for skipping the directory picker entirely. Returns
   * null when the saved handle can't be used silently (permission
   * decayed, volume not mounted, no saved handle).
   */
  const trySavedHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
    const saved = await loadXiaoBootHandle();
    if (!saved) return null;
    const perm = await queryHandlePermission(saved);
    if (perm !== 'granted') return null;
    if (!(await isHandleAccessible(saved))) return null;
    return saved;
  };

  const startWizard = () => {
    if (mode === 'clean' && !resetAsset) {
      setPhase({
        kind: 'error',
        message:
          'リセット用ファームウェア (*-reset.uf2) がリリースに含まれていません。ワークフローが最新ビルドを公開するまで通常インストールをお使いください。',
        resumeStage: 'reset',
      });
      return;
    }
    const firstStage: Stage = mode === 'clean' ? 'reset' : 'normal';
    const transport = autoJumpTransport();
    if (transport) {
      void runAutoJumpFlow(firstStage, transport);
    } else {
      setPhase({ kind: 'awaiting-physical-reset', stage: firstStage });
    }
  };

  /**
   * Auto-jump pipeline: send Vial BootloaderJump → wait for OS mount
   * → try saved handle, falling back to a "pick XIAO-BOOT" step.
   */
  const runAutoJumpFlow = async (stage: Stage, transport: WebHidTransport) => {
    setPhase({ kind: 'jumping-to-bootloader', stage });
    await enterBootloader(transport);
    setPhase({ kind: 'waiting-for-mount', stage });
    if (mountWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, mountWaitMs));
    }
    const saved = await trySavedHandle();
    if (saved) {
      // Silent re-use — no picker needed. The verify step also
      // re-confirms accessibility so we never hand stale handles to
      // writeUf2().
      await runFromHandle(stage, saved, 'auto-jumped');
      return;
    }
    setPhase({ kind: 'ready-to-pick', stage, reason: 'auto-jumped' });
  };

  /**
   * From the moment we have a directory handle, the write flow is
   * the same regardless of how we got there (auto-saved, fresh
   * pick, or physical-reset fallback). `reason` controls which
   * back-screen to bounce to on user cancel.
   */
  const runFromHandle = async (
    stage: Stage,
    dir: FileSystemDirectoryHandle,
    reason: ReadyReason,
  ) => {
    const stageAsset = assetForStage(stage);
    if (!stageAsset) {
      setPhase({
        kind: 'error',
        message: 'インストール対象の uf2 が見つかりません。',
        resumeStage: stage,
      });
      return;
    }

    setPhase({ kind: 'verifying', stage, dir });
    try {
      const info = await verifyXiaoBootDirectory(dir);
      if (info === null) {
        const proceed = window.confirm(
          '選択したフォルダに INFO_UF2.TXT が見つかりません。XIAO-BOOT ではない可能性があります。続行しますか？',
        );
        if (!proceed) {
          if (reason === 'auto-jumped') {
            setPhase({ kind: 'ready-to-pick', stage, reason });
          } else {
            setPhase({ kind: 'awaiting-physical-reset', stage });
          }
          return;
        }
      }
    } catch (err) {
      setPhase({
        kind: 'error',
        message: `XIAO-BOOT の確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        resumeStage: stage,
      });
      return;
    }

    setPhase({ kind: 'fetching', stage, dir, loaded: 0, total: null });
    let bytes: Uint8Array;
    try {
      bytes = await fetchUf2(stageAsset.downloadUrl, (loaded, total) => {
        setPhase({ kind: 'fetching', stage, dir, loaded, total });
      });
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        resumeStage: stage,
      });
      return;
    }

    setPhase({ kind: 'writing', stage, dir });
    try {
      await writeUf2(dir, stageAsset.name, bytes);
      if (mode === 'clean' && stage === 'reset') {
        setPhase({ kind: 'stage1-done' });
      } else {
        setPhase({ kind: 'done' });
      }
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        resumeStage: stage,
      });
    }
  };

  /**
   * Open the directory picker and then continue with `runFromHandle`.
   * Saves the picked handle so subsequent installs skip this step.
   */
  const pickAndWrite = async (stage: Stage, reason: ReadyReason) => {
    let dir: FileSystemDirectoryHandle;
    setPhase({ kind: 'picking', stage });
    try {
      dir = await pickXiaoBoot();
    } catch (err) {
      if (err instanceof InstallError && err.kind === 'picker-cancelled') {
        // Bounce back to the ready / wait screen so the user can
        // either retry the picker or cancel out.
        if (reason === 'auto-jumped') {
          setPhase({ kind: 'ready-to-pick', stage, reason });
        } else {
          setPhase({ kind: 'awaiting-physical-reset', stage });
        }
        return;
      }
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        resumeStage: stage,
      });
      return;
    }

    // Best-effort persistence — failures inside IDB don't block the
    // install. The user just loses the shortcut on the next run.
    void saveXiaoBootHandle(dir);
    // Re-grant the saved handle's permission once we already have a
    // user gesture in flight. Some OS / Chromium combos demote
    // permission immediately after the picker closes if you don't
    // request again. Cheap belt-and-braces.
    try {
      await requestHandlePermission(dir);
    } catch {
      // ignore — write will surface any real permission problem
    }
    await runFromHandle(stage, dir, reason);
  };

  if (!supported) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 p-3 text-xs text-zinc-600 dark:text-zinc-300">
        <p className="font-medium">{primaryLabel(label, mode)}</p>
        <p className="mt-1">
          このブラウザはワンクリックインストールに対応していません。Chrome / Edge / Brave / Opera
          を使うか、左の「ダウンロード」リンクから手動で書き込んでください。
        </p>
      </div>
    );
  }

  if (phase.kind === 'idle') {
    return (
      <button
        type="button"
        onClick={startWizard}
        className={
          mode === 'clean'
            ? 'w-full rounded-md border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-950/40 px-4 py-1.5 text-xs font-medium'
            : 'w-full rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm font-medium'
        }
      >
        {primaryLabel(label, mode)}
      </button>
    );
  }

  return (
    <div
      className={
        mode === 'clean'
          ? 'rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-3 text-sm'
          : 'rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 p-4 space-y-3 text-sm'
      }
    >
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-semibold">{primaryLabel(label, mode)}</h4>
        <button
          type="button"
          onClick={close}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline"
        >
          キャンセル
        </button>
      </header>

      {mode === 'clean' && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{stageBanner(phase)}</p>
      )}

      {phase.kind === 'jumping-to-bootloader' && (
        <div className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
          <Spinner />
          <span>kobu をブートローダーモードに切り替え中…</span>
        </div>
      )}

      {phase.kind === 'waiting-for-mount' && (
        <div className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
          <Spinner />
          <span>XIAO-BOOT のマウントを待っています…</span>
        </div>
      )}

      {phase.kind === 'awaiting-physical-reset' && (
        <div className="space-y-2">
          <ol className="list-decimal list-inside text-xs text-zinc-700 dark:text-zinc-300 space-y-1">
            <li>{label}の XIAO BLE を USB-C で接続</li>
            <li>RESET ボタンを素早く 2 回押す</li>
            <li>
              OS のファイルマネージャに <span className="font-mono">XIAO-BOOT</span>{' '}
              が表示されたら次へ
            </li>
          </ol>
          <button
            type="button"
            onClick={() => {
              void pickAndWrite(phase.stage, 'physical-reset');
            }}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-medium"
          >
            XIAO-BOOT を選択して{phase.stage === 'reset' ? 'リセット uf2 を' : 'uf2 を'}書き込み
          </button>
        </div>
      )}

      {phase.kind === 'ready-to-pick' && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-700 dark:text-zinc-300">
            ✓ kobu をブートローダーモードに切り替えました。
            <span className="font-mono">XIAO-BOOT</span>{' '}
            ボリュームを選択するとすぐに書き込みが始まります。
          </p>
          <button
            type="button"
            onClick={() => {
              void pickAndWrite(phase.stage, phase.reason);
            }}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-medium"
          >
            XIAO-BOOT を選択して{phase.stage === 'reset' ? 'リセット uf2 を' : 'uf2 を'}書き込み
          </button>
        </div>
      )}

      {(phase.kind === 'picking' || phase.kind === 'verifying' || phase.kind === 'writing') && (
        <div className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
          <Spinner />
          <span>{phaseLabel(phase.kind)}</span>
        </div>
      )}

      {phase.kind === 'fetching' && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-700 dark:text-zinc-300">
            <span>uf2 をダウンロード中…</span>
            <span className="font-mono tabular-nums">
              {progressLabel(phase.loaded, phase.total)}
            </span>
          </div>
          <ProgressBar loaded={phase.loaded} total={phase.total} />
        </div>
      )}

      {phase.kind === 'stage1-done' && (
        <div className="space-y-2">
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            ✓ ステップ 1/2 完了: リセット uf2 を書き込みました。XIAO が再起動し、keymap が
            工場出荷状態にクリアされます。
          </p>
          <p className="text-xs text-zinc-700 dark:text-zinc-300">
            続けて通常版を書き込みます。再度 RESET を 2 連打して XIAO-BOOT を出してください。
          </p>
          <button
            type="button"
            onClick={() => {
              // Stage 2 runs the same start logic — if the connection
              // came back after the reset firmware booted, we'll
              // auto-jump again; otherwise the physical-reset wizard
              // takes over.
              const transport = autoJumpTransport();
              if (transport) {
                void runAutoJumpFlow('normal', transport);
              } else {
                setPhase({ kind: 'awaiting-physical-reset', stage: 'normal' });
              }
            }}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-medium"
          >
            次へ (通常 uf2 のインストール)
          </button>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="space-y-2">
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            ✓ 書き込みが完了しました。XIAO が自動的に再起動します。
            {mode === 'clean' && (
              <>
                <br />
                工場出荷時のキーマップで起動します。BLE のペアリング情報は維持されています。
              </>
            )}
          </p>
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            閉じる
          </button>
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="space-y-2">
          <p className="text-xs text-rose-700 dark:text-rose-400">エラー: {phase.message}</p>
          <button
            type="button"
            onClick={() => {
              // Restart the wizard from scratch so the retry picks up
              // whatever transport state is current (e.g. connection
              // dropped → fall back to physical reset).
              setPhase({ kind: 'idle' });
              startWizard();
            }}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            やり直す
          </button>
        </div>
      )}
    </div>
  );
}

function primaryLabel(label: string, mode: InstallMode): string {
  return mode === 'clean'
    ? `${label}を工場出荷状態に戻して再インストール`
    : `${label}をインストール`;
}

function stageBanner(phase: Phase): string {
  if (phase.kind === 'stage1-done') return 'ステップ 1/2 完了 → ステップ 2/2 へ';
  if (phase.kind === 'done') return '完了';
  if (phase.kind === 'error') {
    return phase.resumeStage === 'reset' ? 'ステップ 1/2: リセット uf2' : 'ステップ 2/2: 通常 uf2';
  }
  const stage =
    phase.kind === 'jumping-to-bootloader' ||
    phase.kind === 'waiting-for-mount' ||
    phase.kind === 'awaiting-physical-reset' ||
    phase.kind === 'ready-to-pick' ||
    phase.kind === 'picking' ||
    phase.kind === 'verifying' ||
    phase.kind === 'fetching' ||
    phase.kind === 'writing'
      ? phase.stage
      : 'reset';
  return stage === 'reset' ? 'ステップ 1/2: リセット uf2' : 'ステップ 2/2: 通常 uf2';
}

function phaseLabel(kind: 'picking' | 'verifying' | 'writing'): string {
  switch (kind) {
    case 'picking':
      return 'XIAO-BOOT を選択してください…';
    case 'verifying':
      return 'XIAO-BOOT を確認中…';
    case 'writing':
      return 'XIAO へ書き込み中…';
  }
}

function Spinner() {
  return (
    <span
      role="status"
      aria-label="読み込み中"
      className="inline-block h-3.5 w-3.5 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin"
    />
  );
}

interface ProgressBarProps {
  loaded: number;
  total: number | null;
}

function ProgressBar({ loaded, total }: ProgressBarProps) {
  const percent = total && total > 0 ? Math.min(100, (loaded / total) * 100) : null;
  return (
    <div
      role="progressbar"
      aria-valuenow={percent ?? undefined}
      aria-valuemin={0}
      aria-valuemax={total ?? undefined}
      aria-label="ダウンロード進捗"
      className="w-full h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden"
    >
      {percent !== null ? (
        <div
          className="h-full bg-emerald-600 transition-all duration-150"
          style={{ width: `${percent}%` }}
        />
      ) : (
        // Indeterminate (no Content-Length): pulse a full-width bar so
        // the user sees that download is in progress.
        <div className="h-full w-full bg-emerald-600 animate-pulse" />
      )}
    </div>
  );
}

function progressLabel(loaded: number, total: number | null): string {
  const fmt = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };
  if (total === null) return fmt(loaded);
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  return `${fmt(loaded)} / ${fmt(total)} (${pct}%)`;
}
