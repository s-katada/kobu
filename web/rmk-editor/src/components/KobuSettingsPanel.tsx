/**
 * kobu-specific settings panel — Phase 6.2 deliverable.
 *
 * Renders three categories from `state/kobuSettings.ts`:
 *
 *   * Trackball (CPI multiplier)
 *   * Scroll    (throttle + per-axis invert)
 *   * Status LED (purple hold + battery thresholds)
 *
 * Sliders / toggles commit through the debounced store, so a
 * continuous slider drag results in one wire write per slot once the
 * user lets go. Each category has a "デフォルトに戻す" button that
 * resets just that category's values; a global reset lives in the
 * footer.
 *
 * Writes go live via the build.rs RMK patches
 * (`patch_rmk_via_custom_*`): a CustomSetValue lands directly in the
 * `crate::input_device::battery::KOBU_*` atomics that
 * `firmware/src/{trackball,status_led}.rs` consult on every event,
 * so a slider drag is visible in pointer / LED behaviour immediately.
 *
 * Persistence across reboots is still deferred (issue #39): every
 * boot reloads `KobuSettings::default()`. The dismissible banner at
 * the top of the panel explains this.
 */

import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { KOBU_VALUES, type KobuSettingKey } from '../protocol/customValue';
import {
  SCROLL_KEYS,
  STATUS_LED_KEYS,
  TRACKBALL_KEYS,
  useKobuSettingsStore,
} from '../state/kobuSettings';

export function KobuSettingsPanel() {
  const phase = useKobuSettingsStore((s) => s.phase);
  const local = useKobuSettingsStore(useShallow((s) => s.local));
  const setValue = useKobuSettingsStore((s) => s.setValue);
  const resetCategory = useKobuSettingsStore((s) => s.resetCategory);
  const resetAll = useKobuSettingsStore((s) => s.resetAll);
  const reload = useKobuSettingsStore((s) => s.reloadFromDevice);

  const [bannerDismissed, setBannerDismissed] = useState(false);

  if (phase.kind === 'empty' || phase.kind === 'loading') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">kobu 設定を読み込み中…</p>;
  }

  const error = phase.kind === 'error' ? phase.message : null;

  return (
    <section
      aria-labelledby="kobu-settings-heading"
      className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
        <h3 id="kobu-settings-heading" className="text-sm font-medium">
          kobu 設定
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          トラックボール / スクロール / ステータス LED の調整。スライダーをドラッグで即時反映。
        </p>
      </header>

      {!bannerDismissed && (
        <div className="px-4 py-2 border-b border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 flex items-start gap-3 text-xs">
          <div className="flex-1">
            <p className="font-medium">変更はすぐに反映されます</p>
            <p className="text-zinc-700 dark:text-zinc-300 mt-0.5">
              スライダー / トグルを変更するとファームウェアにその場で送信され、トラックボール
              とステータス LED に即時反映されます。ただし現在は再起動を跨いだ永続化は未対応で、 kobu
              を再起動するとすべての値が既定値に戻ります（追跡:{' '}
              <a
                href="https://github.com/s-katada/kobu/issues/39"
                target="_blank"
                rel="noreferrer"
                className="underline hover:no-underline"
              >
                #39
              </a>
              ）。
            </p>
          </div>
          <button
            type="button"
            aria-label="非表示"
            onClick={() => setBannerDismissed(true)}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            ×
          </button>
        </div>
      )}

      <Category
        title="トラックボール"
        keys={TRACKBALL_KEYS}
        local={local}
        setValue={setValue}
        onReset={() => resetCategory(TRACKBALL_KEYS)}
      />
      <Category
        title="スクロール"
        keys={SCROLL_KEYS}
        local={local}
        setValue={setValue}
        onReset={() => resetCategory(SCROLL_KEYS)}
      />
      <Category
        title="ステータス LED"
        keys={STATUS_LED_KEYS}
        local={local}
        setValue={setValue}
        onReset={() => resetCategory(STATUS_LED_KEYS)}
      />

      <footer className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 flex flex-wrap items-center justify-end gap-2 bg-zinc-50 dark:bg-zinc-900">
        <button
          type="button"
          onClick={() => {
            void reload();
          }}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          デバイスから再読込
        </button>
        <button
          type="button"
          onClick={resetAll}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          全て出荷時に戻す
        </button>
        {error && <div className="w-full text-sm text-rose-700 dark:text-rose-400">{error}</div>}
      </footer>
    </section>
  );
}

interface CategoryProps {
  title: string;
  keys: readonly KobuSettingKey[];
  local: Record<KobuSettingKey, number>;
  setValue: (key: KobuSettingKey, value: number) => void;
  onReset: () => void;
}

function Category({ title, keys, local, setValue, onReset }: CategoryProps) {
  return (
    <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 last:border-b-0">
      <div className="flex items-center mb-2">
        <h4 className="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          {title}
        </h4>
        <button
          type="button"
          onClick={onReset}
          className="ml-auto rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          このカテゴリを初期化
        </button>
      </div>
      <div className="space-y-3">
        {keys.map((key) => (
          <SettingRow
            key={key}
            keyName={key}
            value={local[key]}
            onChange={(v) => setValue(key, v)}
          />
        ))}
      </div>
    </div>
  );
}

interface SettingRowProps {
  keyName: KobuSettingKey;
  value: number;
  onChange: (next: number) => void;
}

/** スライダー / トグル 1 行。`TrackballDock` からも再利用される。 */
export function SettingRow({ keyName, value, onChange }: SettingRowProps) {
  const def = KOBU_VALUES.find((v) => v.key === keyName);
  if (!def) return null;
  const label = SETTING_LABELS[keyName];

  if (def.type === 'bool') {
    return (
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          <span className="block">{label.title}</span>
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            {label.description}
          </span>
        </span>
        <input
          type="checkbox"
          checked={value !== 0}
          onChange={(e) => onChange(e.target.checked ? 1 : 0)}
          className="h-4 w-4"
          aria-label={label.title}
        />
      </label>
    );
  }

  // u8 / u16 — sliders with a numeric readout.
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span>
          <span className="block">{label.title}</span>
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            {label.description}
          </span>
        </span>
        <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
          {value}
          {label.unit ?? ''}
        </span>
      </div>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={label.step ?? 1}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        aria-label={label.title}
        className="w-full"
      />
    </div>
  );
}

interface SettingLabel {
  title: string;
  description: string;
  unit?: string;
  step?: number;
}

/** 設定キー → 表示ラベル。`TrackballDock` と共有する単一の出典。 */
export const SETTING_LABELS: Record<KobuSettingKey, SettingLabel> = {
  trackball_cpi: {
    title: 'CPI',
    description: 'ポインタ感度の倍率。大きいほど動きが速くなります。',
    step: 200,
  },
  scroll_throttle_ms: {
    title: 'スクロール間隔',
    description: '連続スクロール報告の最小間隔。0 で制限なし。',
    unit: ' ms',
  },
  scroll_invert_x: {
    title: '横スクロール反転',
    description: '左右のスクロール方向を入れ替えます。',
  },
  scroll_invert_y: {
    title: '縦スクロール反転',
    description: '上下のスクロール方向を入れ替えます。',
  },
  status_led_purple_hold_ms: {
    title: 'パープル保持時間',
    description: '右トラックボール操作後に LED を紫に保つ時間。0 で無効。',
    unit: ' ms',
    step: 50,
  },
  status_led_battery_high_threshold: {
    title: 'バッテリ緑しきい値',
    description: 'この値より上で LED が緑になります。',
    unit: ' %',
  },
  status_led_battery_low_threshold: {
    title: 'バッテリ赤しきい値',
    description: 'この値以下で LED が赤になります。',
    unit: ' %',
  },
  // Read-only display values — surfaced in `KobuBatteryPanel` rather than
  // this settings panel. Labels exist only because `LABELS` is keyed by
  // the full `KobuSettingKey` union.
  central_battery_percent: {
    title: '左バッテリー',
    description: 'central XIAO の LiPo 残量 (読み取り専用)。',
    unit: ' %',
  },
  peripheral_battery_percent: {
    title: '右バッテリー',
    description: 'peripheral XIAO の LiPo 残量 (読み取り専用)。',
    unit: ' %',
  },
};
