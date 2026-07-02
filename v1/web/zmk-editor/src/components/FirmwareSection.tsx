import { isFileSystemAccessSupported } from '../install/filesystem';
import { ZMK_TARGETS } from '../install/targets';
import { findAsset, formatBytes, useFirmwareReleases } from '../state/firmware';
import { InstallButton } from './InstallButton';

export function FirmwareSection() {
  const { state, refresh } = useFirmwareReleases();
  const fsSupported = isFileSystemAccessSupported();

  const latest =
    state.kind === 'ready'
      ? (state.releases.find((r) => r.isLatest) ?? state.releases[0])
      : undefined;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">ファームウェア（ZMK）のインストール</h2>
        <button
          type="button"
          onClick={refresh}
          className="text-xs text-sky-600 underline hover:text-sky-500 dark:text-sky-400"
        >
          再読み込み
        </button>
      </div>

      <ol className="list-decimal space-y-1 rounded-md border border-zinc-200 bg-zinc-50 p-4 pl-8 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        <li>
          書き込む半分の RESET ボタンを素早く 2 回押し、ブートローダー（XIAO-BOOT）を表示します。
        </li>
        <li>下のボタンを押し、表示された XIAO-BOOT フォルダを選択します。</li>
        <li>UF2 が書き込まれ、デバイスが自動で再起動します。</li>
      </ol>

      {!fsSupported && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          このブラウザは File System Access API に未対応のため、ここからの書き込みはできません。
          ライブ編集は利用できます。
        </p>
      )}

      {state.kind === 'loading' && <p className="text-sm text-zinc-500">リリースを取得中…</p>}
      {state.kind === 'error' && (
        <p className="text-sm text-red-600 dark:text-red-400">
          リリースの取得に失敗しました: {state.message}
        </p>
      )}

      {latest && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-500">
            最新ビルド:{' '}
            <a
              href={latest.htmlUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sky-600 underline dark:text-sky-400"
            >
              {latest.name}
            </a>{' '}
            （{new Date(latest.publishedAt).toLocaleString('ja-JP')}）
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {ZMK_TARGETS.map((target) => {
              const asset = findAsset(latest, target.asset);
              return (
                <div
                  key={target.id}
                  className="space-y-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  <div>
                    <p className="font-medium">{target.label}</p>
                    <p className="text-xs text-zinc-500">{target.description}</p>
                  </div>
                  <p className="text-xs text-zinc-400">
                    {target.asset}
                    {asset ? ` · ${formatBytes(asset.size)}` : ' · （見つかりません）'}
                  </p>
                  <InstallButton asset={target.asset} downloadUrl={asset?.downloadUrl} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
