/**
 * Firmware download + install section.
 *
 * Shows the latest GitHub release of kobu firmware (`firmware-latest`
 * pre-release, plus any tagged `firmware-vX.Y.Z` builds) with one-click
 * download buttons for `central.uf2` and `peripheral.uf2`, plus a short
 * installation guide. When a kobu is currently connected, a "Enter
 * bootloader" button sends the Vial `BootloaderJump` command so the
 * central reboots into UF2 mode without a physical reset.
 *
 * The section is always visible — users typically arrive here to
 * install firmware *before* they can connect, so we shouldn't gate it
 * on the connection state.
 */

import { useState } from 'react';
import { enterBootloader } from '../protocol/device';
import { useConnectionStore } from '../state/connection';
import {
  type FirmwareRelease,
  findAsset,
  formatBytes,
  useFirmwareReleases,
} from '../state/firmware';

export function FirmwareSection() {
  const { state, refresh } = useFirmwareReleases();

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium">ファームウェア</h2>
        <button
          type="button"
          onClick={refresh}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline"
        >
          再取得
        </button>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        GitHub Actions が自動ビルドした kobu の最新ファームウェアです。central / peripheral
        それぞれの uf2 をダウンロードし、対象の XIAO BLE
        をブートローダモードにして書き込んでください。
      </p>

      {state.kind === 'loading' && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">リリース情報を取得中…</p>
      )}

      {state.kind === 'error' && (
        <div className="rounded-md border border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/40 p-3 text-sm">
          リリース情報の取得に失敗しました: {state.message}
        </div>
      )}

      {state.kind === 'ready' && state.releases.length === 0 && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm">
          公開済みのファームウェアビルドがまだありません。main ブランチへの push 後、
          <a
            className="underline ml-1"
            href="https://github.com/s-katada/kobu/actions/workflows/firmware.yml"
            target="_blank"
            rel="noreferrer"
          >
            Firmware ワークフロー
          </a>
          が成功すると <code>firmware-latest</code> が自動生成されます。
        </div>
      )}

      {state.kind === 'ready' &&
        state.releases.map((release) => <ReleaseCard key={release.tag} release={release} />)}

      <InstallGuide />
    </section>
  );
}

function ReleaseCard({ release }: { release: FirmwareRelease }) {
  const central = findAsset(release, 'central.uf2');
  const peripheral = findAsset(release, 'peripheral.uf2');
  const published = formatPublishedAt(release.publishedAt);

  return (
    <article className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 space-y-3 bg-white dark:bg-zinc-900">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {release.name}
          {release.isLatest && (
            <span className="ml-2 inline-block rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              latest
            </span>
          )}
          {!release.isLatest && release.isPrerelease && (
            <span className="ml-2 inline-block rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              pre-release
            </span>
          )}
        </h3>
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-zinc-500 hover:underline"
        >
          リリースページを開く ↗
        </a>
      </header>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">公開日時: {published}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <AssetButton label="セントラル (左半分)" asset={central} fallbackName="central.uf2" />
        <AssetButton
          label="ペリフェラル (右半分)"
          asset={peripheral}
          fallbackName="peripheral.uf2"
        />
      </div>

      {release.body && (
        <details className="text-xs text-zinc-600 dark:text-zinc-400">
          <summary className="cursor-pointer select-none">リリースノート</summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans">{release.body}</pre>
        </details>
      )}
    </article>
  );
}

interface AssetButtonProps {
  label: string;
  asset: ReturnType<typeof findAsset>;
  fallbackName: string;
}

function AssetButton({ label, asset, fallbackName }: AssetButtonProps) {
  if (!asset) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 p-3 text-xs text-zinc-500">
        <p className="font-medium">{label}</p>
        <p className="mt-1">{fallbackName} がまだアップロードされていません</p>
      </div>
    );
  }
  return (
    <a
      href={asset.downloadUrl}
      download={asset.name}
      className="rounded-md border border-zinc-300 dark:border-zinc-700 p-3 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 block"
    >
      <p className="font-medium">{label}</p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-mono">{asset.name}</span> ・ {formatBytes(asset.size)}
      </p>
      <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">ダウンロード ↓</p>
    </a>
  );
}

function InstallGuide() {
  const connection = useConnectionStore((s) => s.state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onJump() {
    if (connection.kind !== 'ready') return;
    setError(null);
    setBusy(true);
    try {
      await enterBootloader(connection.transport);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 space-y-3 text-sm">
      <h3 className="font-semibold">インストール手順</h3>
      <ol className="list-decimal list-inside space-y-2 text-zinc-700 dark:text-zinc-300">
        <li>
          上のボタンから <span className="font-mono">central.uf2</span> /{' '}
          <span className="font-mono">peripheral.uf2</span> をダウンロード
        </li>
        <li>
          書き込み対象の XIAO BLE をブートローダモードに入れる
          <ul className="mt-1 ml-4 list-disc list-inside text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5">
            <li>物理 RESET ボタンを 2 回素早く押す</li>
            <li>または、kobu に接続済みの場合は下の「ブートローダへ移行」ボタンを押す</li>
          </ul>
        </li>
        <li>
          OS のファイルマネージャに <span className="font-mono">XIAO-BOOT</span> ボリュームが現れる
        </li>
        <li>ダウンロードした uf2 をそのボリュームへドラッグ&ドロップ</li>
        <li>書き込みが終わると自動的に再起動し、ボリュームが消える</li>
      </ol>

      <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void onJump();
            }}
            disabled={connection.kind !== 'ready' || busy}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? '送信中…' : 'ブートローダへ移行 (central)'}
          </button>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {connection.kind === 'ready'
              ? '接続中の central を UF2 モードへ再起動します。ペリフェラルは物理 RESET が必要です。'
              : '接続中のときに有効になります（USB / BLE どちらでも）。'}
          </p>
        </div>
        {error && <p className="text-xs text-rose-700 dark:text-rose-400">エラー: {error}</p>}
      </div>
    </div>
  );
}

function formatPublishedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}
