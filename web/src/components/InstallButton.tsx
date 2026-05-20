/**
 * Self-contained install flow for one UF2 asset.
 *
 * Click → wizard expands inline:
 *   1. 物理 RESET の案内 (両側とも手動 — Vial の BootloaderJump は使わない)
 *   2. `[XIAO-BOOT を選択]` — File System Access API のディレクトリピッカー
 *   3. INFO_UF2.TXT の有無で sanity check。怪しければ確認ダイアログ
 *   4. uf2 を fetch (HTTP cache に乗るので 2 回目以降は速い)
 *   5. dir.write(uf2 bytes) → 完了表示
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

export interface InstallButtonProps {
  /** UI label, e.g. "セントラル (左半分)". */
  label: string;
  /** Release asset (download URL + filename). */
  asset: FirmwareAsset;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'awaiting-reset' }
  | { kind: 'picking' }
  | { kind: 'verifying'; dir: FileSystemDirectoryHandle }
  | { kind: 'fetching'; dir: FileSystemDirectoryHandle }
  | { kind: 'writing'; dir: FileSystemDirectoryHandle }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export function InstallButton({ label, asset }: InstallButtonProps) {
  const supported = isFileSystemAccessSupported();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const reset = useCallback(() => setPhase({ kind: 'idle' }), []);

  const startWizard = () => {
    setPhase({ kind: 'awaiting-reset' });
  };

  const pickAndWrite = async (skipVerify = false) => {
    let dir: FileSystemDirectoryHandle;
    setPhase({ kind: 'picking' });
    try {
      dir = await pickXiaoBoot();
    } catch (err) {
      if (err instanceof InstallError && err.kind === 'picker-cancelled') {
        setPhase({ kind: 'awaiting-reset' });
        return;
      }
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!skipVerify) {
      setPhase({ kind: 'verifying', dir });
      try {
        const info = await verifyXiaoBootDirectory(dir);
        if (info === null) {
          // Not an Adafruit UF2 volume — let the user decide.
          const proceed = window.confirm(
            '選択したフォルダに INFO_UF2.TXT が見つかりません。XIAO-BOOT ではない可能性があります。続行しますか？',
          );
          if (!proceed) {
            setPhase({ kind: 'awaiting-reset' });
            return;
          }
        }
      } catch (err) {
        setPhase({
          kind: 'error',
          message: `XIAO-BOOT の確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
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
      });
    }
  };

  if (!supported) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 p-3 text-xs text-zinc-600 dark:text-zinc-300">
        <p className="font-medium">{label}</p>
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
        className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm font-medium"
      >
        {label}をインストール
      </button>
    );
  }

  return (
    <div className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 p-4 space-y-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-semibold">{label}をインストール</h4>
        <button
          type="button"
          onClick={reset}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline"
        >
          キャンセル
        </button>
      </header>

      {phase.kind === 'awaiting-reset' && (
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
          </p>
          <button
            type="button"
            onClick={reset}
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
            onClick={() => setPhase({ kind: 'awaiting-reset' })}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            やり直す
          </button>
        </div>
      )}
    </div>
  );
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
