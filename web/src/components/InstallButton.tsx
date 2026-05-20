/**
 * Self-contained install flow for one UF2 asset.
 *
 * Two modes:
 *
 *   * `preserve` (default) — single-stage. Physical RESET → pick
 *     XIAO-BOOT → write the normal `*.uf2`. RMK's storage region is
 *     untouched, so the user's customised keymap survives the update.
 *
 *   * `clean` — two-stage. RMK 0.8 doesn't implement the Via
 *     DynamicKeymapReset command (the handler is a no-op), so we
 *     can't wipe the keymap via the wire protocol. Instead we ship a
 *     second build of the firmware with `clear_layout = true` in
 *     keyboard.toml's [storage] section. The flow is:
 *
 *       Stage 1: flash `*-reset.uf2`. On boot the firmware clears the
 *                layout region (BLE bonds survive) and continues to
 *                run normally — but every subsequent boot would
 *                clear the layout again, so we must …
 *       Stage 2: flash the normal `*.uf2`. The device now boots with
 *                an empty storage and the build-time default keymap
 *                from keyboard.toml; future customisations persist.
 *
 *     The user does a manual RESET 2-tap between stages.
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
import { fetchUf2, verifyXiaoBootDirectory } from '../install/install';
import type { FirmwareAsset } from '../state/firmware';

export type InstallMode = 'preserve' | 'clean';

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
}

type Stage = 'reset' | 'normal';

type Phase =
  | { kind: 'idle' }
  | { kind: 'awaiting-physical-reset'; stage: Stage } // user has to RESET 2-tap
  | { kind: 'picking'; stage: Stage }
  | { kind: 'verifying'; stage: Stage; dir: FileSystemDirectoryHandle }
  | { kind: 'fetching'; stage: Stage; dir: FileSystemDirectoryHandle }
  | { kind: 'writing'; stage: Stage; dir: FileSystemDirectoryHandle }
  | { kind: 'stage1-done' } // clean mode only — between reset and normal flash
  | { kind: 'done' }
  | { kind: 'error'; message: string; resumeStage: Stage };

export function InstallButton({ label, asset, mode = 'preserve', resetAsset }: InstallButtonProps) {
  const supported = isFileSystemAccessSupported();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const close = useCallback(() => setPhase({ kind: 'idle' }), []);

  // The clean flow ships TWO writes; pick which asset belongs to which
  // stage so the rest of the wizard can stay stage-agnostic.
  const assetForStage = (stage: Stage): FirmwareAsset | undefined =>
    stage === 'reset' ? resetAsset : asset;

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
    setPhase({ kind: 'awaiting-physical-reset', stage: firstStage });
  };

  const pickAndWrite = async (stage: Stage, skipVerify = false) => {
    const stageAsset = assetForStage(stage);
    if (!stageAsset) {
      setPhase({
        kind: 'error',
        message: 'インストール対象の uf2 が見つかりません。',
        resumeStage: stage,
      });
      return;
    }

    let dir: FileSystemDirectoryHandle;
    setPhase({ kind: 'picking', stage });
    try {
      dir = await pickXiaoBoot();
    } catch (err) {
      if (err instanceof InstallError && err.kind === 'picker-cancelled') {
        setPhase({ kind: 'awaiting-physical-reset', stage });
        return;
      }
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        resumeStage: stage,
      });
      return;
    }

    if (!skipVerify) {
      setPhase({ kind: 'verifying', stage, dir });
      try {
        const info = await verifyXiaoBootDirectory(dir);
        if (info === null) {
          const proceed = window.confirm(
            '選択したフォルダに INFO_UF2.TXT が見つかりません。XIAO-BOOT ではない可能性があります。続行しますか？',
          );
          if (!proceed) {
            setPhase({ kind: 'awaiting-physical-reset', stage });
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
    }

    setPhase({ kind: 'fetching', stage, dir });
    let bytes: Uint8Array;
    try {
      bytes = await fetchUf2(stageAsset.downloadUrl);
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
              void pickAndWrite(phase.stage);
            }}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-medium"
          >
            XIAO-BOOT を選択して{phase.stage === 'reset' ? 'リセット uf2 を' : 'uf2 を'}書き込み
          </button>
        </div>
      )}

      {(phase.kind === 'picking' ||
        phase.kind === 'verifying' ||
        phase.kind === 'fetching' ||
        phase.kind === 'writing') && (
        <p className="text-xs text-zinc-700 dark:text-zinc-300">{phaseLabel(phase.kind)}</p>
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
            onClick={() => setPhase({ kind: 'awaiting-physical-reset', stage: 'normal' })}
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
            onClick={() => setPhase({ kind: 'awaiting-physical-reset', stage: phase.resumeStage })}
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
    phase.kind === 'awaiting-physical-reset' ||
    phase.kind === 'picking' ||
    phase.kind === 'verifying' ||
    phase.kind === 'fetching' ||
    phase.kind === 'writing'
      ? phase.stage
      : 'reset';
  return stage === 'reset' ? 'ステップ 1/2: リセット uf2' : 'ステップ 2/2: 通常 uf2';
}

function phaseLabel(kind: 'picking' | 'verifying' | 'fetching' | 'writing'): string {
  switch (kind) {
    case 'picking':
      return 'XIAO-BOOT を選択してください…';
    case 'verifying':
      return 'XIAO-BOOT を確認中…';
    case 'fetching':
      return 'uf2 をダウンロード中…';
    case 'writing':
      return 'XIAO へ書き込み中…';
  }
}
