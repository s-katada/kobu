/**
 * PWA update / offline-ready toasts.
 *
 * `vite-plugin-pwa` virtual module wires the service-worker
 * registration; this component listens for the lifecycle events and
 * renders two toasts:
 *
 *   1. "offline-ready" — fires once on first visit after the SW
 *      finishes precaching. Tells the user they can disconnect from
 *      the network and the editor will still work.
 *   2. "update-available" — fires whenever a new SW takes over. We
 *      use `registerType: 'prompt'` (see `vite.config.ts`) so the
 *      user opts in to reload — without it the page would silently
 *      reload mid-edit and lose unsaved keymap diffs.
 */

import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect, useState } from 'react';

export function PwaUpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error: unknown) {
      // Don't crash the app — log so the user can investigate if the
      // SW doesn't register (e.g. blocked by browser settings or a
      // privacy extension). The biome `noConsole` rule isn't on; if
      // we ever turn it on, surface this warn deliberately.
      console.warn('[pwa] SW registration failed', error);
    },
  });

  // Auto-dismiss the offline-ready toast after ~6s — it's informational.
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(() => setOfflineDismissed(true), 6000);
    return () => clearTimeout(t);
  }, [offlineReady]);

  if (!needRefresh && (!offlineReady || offlineDismissed)) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 max-w-sm space-y-2"
    >
      {needRefresh && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-white dark:bg-zinc-950 shadow-lg p-4 flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm font-medium">新しいバージョンがあります</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              再読み込みして最新版に更新してください。
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => void updateServiceWorker(true)}
              className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 text-xs font-medium"
            >
              更新
            </button>
            <button
              type="button"
              onClick={() => setNeedRefresh(false)}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs"
            >
              あとで
            </button>
          </div>
        </div>
      )}

      {offlineReady && !offlineDismissed && !needRefresh && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-lg p-3 flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm font-medium">オフラインで使えます</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              ネット接続なしでもキーマップ編集を続行できます。
            </p>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={() => {
              setOfflineReady(false);
              setOfflineDismissed(true);
            }}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
