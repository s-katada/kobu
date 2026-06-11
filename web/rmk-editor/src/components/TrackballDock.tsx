/**
 * トラックボール設定ドック。
 *
 * 実機ビューでトラックボールをクリックすると、`KeycodeDock` の代わりに
 * このドックが表示される。クリックしたボールに関係する設定だけを出す:
 *
 *   * 右ボール（ポインタ）: CPI、パープル LED 保持時間、
 *     マウスレイヤー (L4) へのジャンプボタン
 *   * 左ボール（スクロール）: スクロール間隔、縦・横の反転
 *
 * 値の編集は `useKobuSettingsStore.setValue` 経由 — `KobuSettingsPanel`
 * と同じデバウンス付きライブ書き込みなので、スライダーを動かすと
 * その場でポインタ / スクロールの挙動が変わる。
 */

import { useShallow } from 'zustand/react/shallow';
import type { BallSide } from '../layout/kobuPhysical';
import type { KobuSettingKey } from '../protocol/customValue';
import { SCROLL_KEYS, useKobuSettingsStore } from '../state/kobuSettings';
import { SettingRow } from './KobuSettingsPanel';
import { BALL_LABELS } from './PhysicalKeymapView';

/** 右ボール（ポインタ）に効く設定。 */
const POINTER_KEYS: readonly KobuSettingKey[] = ['trackball_cpi', 'status_led_purple_hold_ms'];

export interface TrackballDockProps {
  side: BallSide;
  onClose: () => void;
  /** 右ボールのみ: マウスレイヤー (L4) を開く。 */
  onEditMouseLayer?: (() => void) | undefined;
}

export function TrackballDock({ side, onClose, onEditMouseLayer }: TrackballDockProps) {
  const phase = useKobuSettingsStore((s) => s.phase);
  const local = useKobuSettingsStore(useShallow((s) => s.local));
  const setValue = useKobuSettingsStore((s) => s.setValue);
  const resetCategory = useKobuSettingsStore((s) => s.resetCategory);

  const meta = BALL_LABELS[side];
  const keys = side === 'right' ? POINTER_KEYS : SCROLL_KEYS;
  const error = phase.kind === 'error' ? phase.message : null;

  return (
    <section
      aria-label={`${meta.name}の設定`}
      className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden"
    >
      <header className="flex items-center gap-3 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-900">
        {/* ミニボール */}
        <span
          aria-hidden
          className="relative h-9 w-9 shrink-0 rounded-full border border-zinc-300 dark:border-zinc-500 bg-gradient-to-br from-zinc-50 via-zinc-200 to-zinc-400 dark:from-zinc-400 dark:via-zinc-600 dark:to-zinc-900 shadow-inner"
        >
          <span className="absolute left-[20%] top-[14%] h-[26%] w-[34%] rounded-full bg-white/80 dark:bg-white/35 blur-[2px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {meta.name}
            <span className="ml-2 rounded-full border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400 align-middle">
              {meta.role}
            </span>
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {side === 'right'
              ? 'ボールを転がすと自動でマウスレイヤー (L4) が有効になり、LED が紫になります。'
              : '左ボールはスクロール専用。変更はその場でファームウェアに反映されます。'}
          </p>
        </div>
        <button
          type="button"
          aria-label="トラックボール設定を閉じる"
          onClick={onClose}
          className="rounded px-2 py-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          ×
        </button>
      </header>

      <div className="px-4 py-3 space-y-3">
        {keys.map((key) => (
          <SettingRow
            key={key}
            keyName={key}
            value={local[key]}
            onChange={(v) => setValue(key, v)}
          />
        ))}
      </div>

      <footer className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 flex flex-wrap items-center gap-2 bg-zinc-50 dark:bg-zinc-900">
        {side === 'right' && onEditMouseLayer && (
          <button
            type="button"
            onClick={onEditMouseLayer}
            className="rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/60 px-3 py-1.5 text-sm text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/60"
          >
            マウスレイヤー (L4) を開く
          </button>
        )}
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          設定は再起動で既定値に戻ります（
          <a
            href="https://github.com/s-katada/kobu/issues/39"
            target="_blank"
            rel="noreferrer"
            className="underline hover:no-underline"
          >
            #39
          </a>
          ）
        </span>
        <button
          type="button"
          onClick={() => resetCategory(keys)}
          className="ml-auto rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          このカテゴリを初期化
        </button>
        {error && <div className="w-full text-sm text-rose-700 dark:text-rose-400">{error}</div>}
      </footer>
    </section>
  );
}
