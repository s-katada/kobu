/**
 * Self-contained install flow for one UF2 asset.
 *
 * Two modes:
 *   * `preserve` (default) — physical RESET → pick XIAO-BOOT → write uf2.
 *     Existing on-device keymap (stored in RMK's storage region) is
 *     unchanged. Use this for routine firmware updates.
 *   * `clean` — requires kobu to be connected over Vial first. Sends
 *     `DynamicKeymapReset` (Via 0x06) to wipe the user keymap (BLE
 *     bonds survive), then continues with the normal install flow.
 *     Use this to roll back to the firmware's build-time defaults.
 *
 * Order is deliberate: reset BEFORE flashing so that when the new
 * firmware boots it sees an empty storage region and loads its own
 * defaults. Flashing first then resetting would leave the device
 * running on possibly-incompatible old storage data until the user
 * reconnects.
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
import { resetKeymap } from '../protocol/keymap';
import { useConnectionStore } from '../state/connection';
import type { FirmwareAsset } from '../state/firmware';

export type InstallMode = 'preserve' | 'clean';

export interface InstallButtonProps {
  /** UI label, e.g. "セントラル (左半分)". */
  label: string;
  /** Release asset (download URL + filename). */
  asset: FirmwareAsset;
  /**
   * `preserve` (default) — flash firmware, keep user keymap.
   * `clean` — wipe storage via DynamicKeymapReset then flash.
   */
  mode?: InstallMode;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'awaiting-reset-confirm' } // clean mode only — pre-flash reset confirmation
  | { kind: 'resetting' } // clean mode only — sending DynamicKeymapReset
  | { kind: 'awaiting-physical-reset' } // both modes — user has to RESET 2-tap
  | { kind: 'picking' }
  | { kind: 'verifying'; dir: FileSystemDirectoryHandle }
  | { kind: 'fetching'; dir: FileSystemDirectoryHandle }
  | { kind: 'writing'; dir: FileSystemDirectoryHandle }
  | { kind: 'done' }
  | { kind: 'error'; message: string; resumeFrom: Phase['kind'] };

export function InstallButton({ label, asset, mode = 'preserve' }: InstallButtonProps) {
  const supported = isFileSystemAccessSupported();
  const connection = useConnectionStore((s) => s.state);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const close = useCallback(() => setPhase({ kind: 'idle' }), []);

  const startWizard = () => {
    if (mode === 'clean') {
      setPhase({ kind: 'awaiting-reset-confirm' });
    } else {
      setPhase({ kind: 'awaiting-physical-reset' });
    }
  };

  const runReset = async () => {
    if (connection.kind !== 'ready') {
      setPhase({
        kind: 'error',
        message:
          'クリーンインストールには kobu との接続が必要です。先に上の「接続」パネルから接続してください。',
        resumeFrom: 'awaiting-reset-confirm',
      });
      return;
    }
    setPhase({ kind: 'resetting' });
    try {
      await resetKeymap(connection.transport);
    } catch (err) {
      setPhase({
        kind: 'error',
        message: `キーマップのリセットに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        resumeFrom: 'awaiting-reset-confirm',
      });
      return;
    }
    setPhase({ kind: 'awaiting-physical-reset' });
  };

  const pickAndWrite = async (skipVerify = false) => {
    let dir: FileSystemDirectoryHandle;
    setPhase({ kind: 'picking' });
    try {
      dir = await pickXiaoBoot();
    } catch (err) {
      if (err instanceof InstallError && err.kind === 'picker-cancelled') {
        setPhase({ kind: 'awaiting-physical-reset' });
        return;
      }
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        resumeFrom: 'awaiting-physical-reset',
      });
      return;
    }

    if (!skipVerify) {
      setPhase({ kind: 'verifying', dir });
      try {
        const info = await verifyXiaoBootDirectory(dir);
        if (info === null) {
          const proceed = window.confirm(
            '選択したフォルダに INFO_UF2.TXT が見つかりません。XIAO-BOOT ではない可能性があります。続行しますか？',
          );
          if (!proceed) {
            setPhase({ kind: 'awaiting-physical-reset' });
            return;
          }
        }
      } catch (err) {
        setPhase({
          kind: 'error',
          message: `XIAO-BOOT の確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          resumeFrom: 'awaiting-physical-reset',
        });
        return;
      }
    }

    setPhase({ kind: 'fetching', dir });
    let bytes: Uint8Array;
    try {
      bytes = await fetchUf2(asset.downloadUrl);
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        resumeFrom: 'awaiting-physical-reset',
      });
      return;
    }

    setPhase({ kind: 'writing', dir });
    try {
      await writeUf2(dir, asset.name, bytes);
      setPhase({ kind: 'done' });
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        resumeFrom: 'awaiting-physical-reset',
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

      {phase.kind === 'awaiting-reset-confirm' && (
        <div className="space-y-2 text-xs text-zinc-700 dark:text-zinc-300">
          <p>
            現在のキーマップを <strong>工場出荷状態に戻し</strong>
            、続けてファームウェアを再インストールします。BLE のペアリング情報は保持されます。
          </p>
          <p>
            {connection.kind === 'ready'
              ? '接続中の kobu に対してリセットを送信します。'
              : 'クリーンインストールには kobu の接続が必要です。先に上の「接続」パネルから接続してください。'}
          </p>
          <button
            type="button"
            onClick={() => {
              void runReset();
            }}
            disabled={connection.kind !== 'ready'}
            className="rounded-md bg-amber-600 hover:bg-amber-500 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            リセットを実行
          </button>
        </div>
      )}

      {phase.kind === 'resetting' && (
        <p className="text-xs text-zinc-700 dark:text-zinc-300">キーマップをリセット中…</p>
      )}

      {phase.kind === 'awaiting-physical-reset' && (
        <div className="space-y-2">
          {mode === 'clean' && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">
              ✓ キーマップを工場出荷状態にリセットしました。
            </p>
          )}
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
              void pickAndWrite();
            }}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-medium"
          >
            XIAO-BOOT を選択して書き込み
          </button>
        </div>
      )}

      {(phase.kind === 'picking' ||
        phase.kind === 'verifying' ||
        phase.kind === 'fetching' ||
        phase.kind === 'writing') && (
        <p className="text-xs text-zinc-700 dark:text-zinc-300">{phaseLabel(phase.kind)}</p>
      )}

      {phase.kind === 'done' && (
        <div className="space-y-2">
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            ✓ 書き込みが完了しました。XIAO が自動的に再起動します。
            {mode === 'clean' && (
              <>
                <br />
                工場出荷時のキーマップで起動します。
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
            onClick={() => setPhase({ kind: phase.resumeFrom } as Phase)}
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
