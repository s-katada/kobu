import { useState } from 'react';
import { InstallError, type InstallProgress, runInstall } from '../install/run';

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; progress: InstallProgress }
  | { kind: 'done'; verified: boolean }
  | { kind: 'error'; message: string };

const STEP_LABEL: Record<InstallProgress['step'], string> = {
  picking: 'フォルダを選択中…',
  verifying: 'ボリュームを確認中…',
  downloading: 'UF2 をダウンロード中…',
  writing: '書き込み中…',
  done: '完了',
};

export function InstallButton({
  asset,
  downloadUrl,
}: {
  asset: string;
  downloadUrl: string | undefined;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const working = phase.kind === 'working';

  const run = async () => {
    if (!downloadUrl) return;
    setPhase({ kind: 'working', progress: { step: 'picking' } });
    try {
      const { verified } = await runInstall(downloadUrl, asset, (progress) =>
        setPhase({ kind: 'working', progress }),
      );
      setPhase({ kind: 'done', verified });
    } catch (err) {
      if (err instanceof InstallError && err.kind === 'picker-cancelled') {
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const pct =
    phase.kind === 'working' &&
    phase.progress.step === 'downloading' &&
    phase.progress.total &&
    phase.progress.loaded !== undefined
      ? Math.round((phase.progress.loaded / phase.progress.total) * 100)
      : null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={working || !downloadUrl}
        onClick={() => void run()}
        className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {working ? STEP_LABEL[phase.progress.step] : `${asset} を書き込み`}
      </button>

      {phase.kind === 'working' && phase.progress.step === 'downloading' && (
        <div className="h-1.5 w-48 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full bg-sky-500 transition-all"
            style={{ width: pct !== null ? `${pct}%` : '40%' }}
          />
        </div>
      )}

      {phase.kind === 'done' && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          書き込みが完了しました。デバイスが再起動します。
          {!phase.verified && '（INFO_UF2.TXT が見つかりませんでしたが、書き込みは実行しました）'}
        </p>
      )}

      {phase.kind === 'error' && (
        <p className="text-sm text-red-600 dark:text-red-400">{phase.message}</p>
      )}
    </div>
  );
}
