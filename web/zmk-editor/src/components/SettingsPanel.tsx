import { SETTINGS, type SettingDef } from '../config/settings';
import { useBuildSettingsStore } from '../state/buildSettings';

const FLASH_LABEL: Record<string, string> = {
  'kobu_left.uf2': '左（セントラル）に書き込み',
  'kobu_right.uf2': '右（ペリフェラル）に書き込み',
};

const STEP_LABEL: Record<string, string> = {
  picking: 'フォルダを選択中…',
  verifying: '確認中…',
  downloading: 'ダウンロード中…',
  writing: '書き込み中…',
  done: '完了',
};

function format(def: SettingDef, v: number): string {
  if (def.kind === 'gain') return `${v.toFixed(1)} ${def.unit ?? ''}`.trim();
  return `${v}${def.unit ? ` ${def.unit}` : ''}`;
}

function Slider({ def }: { def: SettingDef }) {
  const value = useBuildSettingsStore((s) => s.values[def.id] ?? def.default);
  const setValue = useBuildSettingsStore((s) => s.setValue);
  const dirty = value !== def.default;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">
          {def.label}
          {dirty && <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">●</span>}
        </span>
        <span className="font-mono text-sm tabular-nums">{format(def, value)}</span>
      </div>
      <input
        type="range"
        className="w-full accent-sky-600"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => setValue(def.id, Number(e.target.value))}
      />
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>{def.description}</span>
        <span>既定: {format(def, def.default)}</span>
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const build = useBuildSettingsStore((s) => s.build);
  const changed = useBuildSettingsStore((s) => s.changed());
  const resetAll = useBuildSettingsStore((s) => s.resetAll);
  const resetBuild = useBuildSettingsStore((s) => s.resetBuild);
  const startBuild = useBuildSettingsStore((s) => s.startBuild);
  const flash = useBuildSettingsStore((s) => s.flash);

  const groups = [...new Set(SETTINGS.map((s) => s.group))];
  const busy =
    build.kind === 'dispatching' || build.kind === 'building' || build.kind === 'flashing';

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-medium">詳細設定（CPI・スクロール・タップ判定・コンボなど）</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          これらは ZMK ではビルド時の値のため、ライブ変更できません。スライダーで調整して
          「ビルドして書き込み」を押すと、GitHub Actions が kobu のファームウェアを再ビルドし
          （数分かかります）、できあがった UF2 をブラウザから書き込めます。
        </p>
      </div>

      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {groups.map((group) => (
          <div key={group} className="space-y-4">
            <h3 className="text-sm font-semibold text-zinc-500">{group}</h3>
            {SETTINGS.filter((s) => s.group === group).map((def) => (
              <Slider key={def.id} def={def} />
            ))}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || changed === 0}
          onClick={() => void startBuild()}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ビルドして書き込み{changed > 0 ? `（変更 ${changed} 件）` : ''}
        </button>
        <button
          type="button"
          disabled={busy || changed === 0}
          onClick={resetAll}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          既定に戻す
        </button>
      </div>

      {build.kind === 'dispatching' && (
        <p className="text-sm text-sky-600 dark:text-sky-400">ビルドを開始しています…</p>
      )}
      {build.kind === 'building' && (
        <p className="text-sm text-sky-600 dark:text-sky-400">
          GitHub Actions でビルド中…（{build.status} · {build.polls * 6}s
          経過）。完了まで数分かかります。
        </p>
      )}
      {build.kind === 'flashing' && (
        <p className="text-sm text-sky-600 dark:text-sky-400">
          {STEP_LABEL[build.progress.step] ?? '書き込み中…'}
        </p>
      )}
      {build.kind === 'built' && (
        <div className="space-y-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/30">
          <p className="text-sm text-emerald-800 dark:text-emerald-200">
            ビルド完了。RESET を 2 回押してブートローダーに入れた半分を選び、書き込んでください。
          </p>
          <div className="flex flex-wrap gap-2">
            {Object.keys(build.files)
              .filter((name) => FLASH_LABEL[name])
              .map((name) => (
                <button
                  type="button"
                  key={name}
                  onClick={() => void flash(name)}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
                >
                  {FLASH_LABEL[name]}
                </button>
              ))}
          </div>
        </div>
      )}
      {build.kind === 'done' && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          書き込みが完了しました。デバイスが再起動します。
        </p>
      )}
      {build.kind === 'error' && (
        <div className="flex items-start gap-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <span className="flex-1">{build.message}</span>
          <button type="button" onClick={resetBuild} className="font-medium underline">
            閉じる
          </button>
        </div>
      )}
    </section>
  );
}
