/**
 * Firmware download + install section.
 *
 * Shows the latest GitHub release of kobu firmware (`firmware-latest`
 * pre-release, plus any tagged `firmware-vX.Y.Z` builds). For each
 * release card we render:
 *
 *   * One-click install (Chromium-only): `InstallButton` walks the user
 *     through reset → directory picker → write. The actual physical
 *     RESET is always manual — we never send `BootloaderJump`.
 *   * Download link as a fallback path for users on Safari / Firefox or
 *     who want to flash from a separate machine.
 *
 * The section is always visible — users typically arrive here to
 * install firmware *before* they can connect, so we shouldn't gate it
 * on the connection state.
 */

import {
  type FirmwareRelease,
  findAsset,
  formatBytes,
  useFirmwareReleases,
} from '../state/firmware';
import { InstallButton, type InstallTarget } from './InstallButton';

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
        GitHub Actions が自動ビルドした kobu の最新ファームウェアです。central / peripheral の XIAO
        BLE をそれぞれブートローダモード (RESET 2 連打)
        にしてから「インストール」を実行してください。
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
    </section>
  );
}

function ReleaseCard({ release }: { release: FirmwareRelease }) {
  // This is the RMK (Vial) editor — it installs the RMK firmware only
  // (central/peripheral + factory-reset). The ZMK build that the same
  // `firmware-latest` release also carries (kobu_left/right/reset.uf2) is
  // deliberately NOT offered here: ZMK is flashed + configured from the
  // separate ZMK editor (web/zmk-editor, ZMK Studio), and installing it from
  // this Vial editor would leave the device unreachable by this very app.
  const central = findAsset(release, 'central.uf2');
  const peripheral = findAsset(release, 'peripheral.uf2');
  const centralReset = findAsset(release, 'central-reset.uf2');
  const peripheralReset = findAsset(release, 'peripheral-reset.uf2');
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <AssetPanel
          label="セントラル (左半分)"
          target="central"
          asset={central}
          resetAsset={centralReset}
          fallbackName="central.uf2"
        />
        <AssetPanel
          label="ペリフェラル (右半分)"
          target="peripheral"
          asset={peripheral}
          resetAsset={peripheralReset}
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

interface AssetPanelProps {
  label: string;
  target: InstallTarget;
  asset: ReturnType<typeof findAsset>;
  resetAsset?: ReturnType<typeof findAsset>;
  fallbackName: string;
}

function AssetPanel({ label, target, asset, resetAsset, fallbackName }: AssetPanelProps) {
  if (!asset) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 p-3 text-xs text-zinc-500 space-y-1">
        <p className="font-medium">{label}</p>
        <p>{fallbackName} がまだアップロードされていません</p>
      </div>
    );
  }
  // Central installs always include the flash-storage clear (clean mode),
  // so the user doesn't have to choose between "preserve keymap" and
  // "factory reset + reinstall". The two-stage clean flow is driven
  // automatically by the single button. Peripheral keeps the preserve
  // path as the default and the clean path as an opt-in extra button.
  const isCentral = target === 'central';
  return (
    <div className="space-y-2">
      {isCentral && resetAsset ? (
        <InstallButton
          label={label}
          target={target}
          asset={asset}
          mode="clean"
          resetAsset={resetAsset}
        />
      ) : (
        <>
          <InstallButton label={label} target={target} asset={asset} />
          {resetAsset && (
            <InstallButton
              label={label}
              target={target}
              asset={asset}
              mode="clean"
              resetAsset={resetAsset}
            />
          )}
        </>
      )}
      <a
        href={asset.downloadUrl}
        download={asset.name}
        className="block text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
      >
        <span className="font-mono">{asset.name}</span> ・ {formatBytes(asset.size)} ・ uf2
        を手動ダウンロード ↓
      </a>
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
