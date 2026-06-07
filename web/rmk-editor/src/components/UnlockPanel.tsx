/**
 * Unlock affordance — the interactive front-end for the Vial unlock chord.
 *
 * Renders a banner near the toolbar that reflects `useUnlockStore`:
 *   - locked     → 🔒 message + 「アンロック」button + which keys to hold
 *   - unlocking  → live countdown bar + "keep holding" + cancel
 *   - unlocked   → 🔓 confirmation + optional 再ロック
 *
 * The keymap view highlights the chord cells while unlocking (driven from the
 * same store), so the user can see exactly which physical keys to hold.
 *
 * a11y: the whole banner is a labelled region; the countdown is announced via
 * aria-live so screen-reader users hear progress, and errors are role="alert".
 */

import { useUnlockStore } from '../state/unlock';

function chordLabel(chord: Array<{ row: number; col: number }>): string {
  if (chord.length === 0) return '';
  return chord.map((c) => `行${c.row}列${c.col}`).join(' ＋ ');
}

export function UnlockPanel() {
  const status = useUnlockStore((s) => s.status);
  const chord = useUnlockStore((s) => s.chord);
  const remaining = useUnlockStore((s) => s.remaining);
  const total = useUnlockStore((s) => s.total);
  const error = useUnlockStore((s) => s.error);
  const beginUnlock = useUnlockStore((s) => s.beginUnlock);
  const cancel = useUnlockStore((s) => s.cancel);
  const relock = useUnlockStore((s) => s.relock);

  // Status not yet known (no transport / first fetch in flight): render nothing.
  if (status === 'unknown') return null;

  if (status === 'unlocked') {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200"
      >
        <span className="font-medium">🔓 アンロック済み — 書き込みできます</span>
        <button
          type="button"
          onClick={() => void relock()}
          className="ml-auto rounded-md border border-emerald-300 dark:border-emerald-800 px-2.5 py-1 text-xs hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
        >
          再ロック
        </button>
      </div>
    );
  }

  const unlocking = status === 'unlocking';
  const pct =
    total > 0 ? Math.max(0, Math.min(100, Math.round(((total - remaining) / total) * 100))) : 0;
  const chordText = chordLabel(chord);

  return (
    <section
      aria-label="ファームウェアのアンロック"
      className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200 space-y-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">🔒 デバイスはロックされています</span>
        <div className="ml-auto flex items-center gap-2">
          {unlocking ? (
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-amber-400 dark:border-amber-700 px-3 py-1 text-xs hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              キャンセル
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void beginUnlock()}
              className="rounded-md bg-amber-500 hover:bg-amber-400 text-amber-950 font-medium px-3 py-1 text-xs"
            >
              アンロック
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-amber-800/90 dark:text-amber-300/90">
        キーマップを書き込むには、ロック解除コード
        {chordText && (
          <>
            （<span className="font-mono">{chordText}</span> ＝ 両端の小指キー）
          </>
        )}
        を約5秒間押し続けてください。
        {unlocking && '下のキーマップで光っているキーです。'}
      </p>

      {unlocking && (
        <div aria-live="assertive" aria-atomic="true">
          <div className="h-2 w-full overflow-hidden rounded-full bg-amber-200 dark:bg-amber-900/60">
            <div
              className="h-full rounded-full bg-amber-500 transition-[width] duration-100"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-xs">
            コードを押し続けてください… {total > 0 ? `あと ${remaining}` : '開始中'}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-rose-700 dark:text-rose-400">
          {error}
        </p>
      )}
    </section>
  );
}
