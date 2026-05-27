/**
 * Inline docked keycode picker.
 *
 * Stays mounted while the editor is open and renders just below the
 * keymap. Selecting a key on the keymap "arms" the dock — clicking a
 * keycode in the grid commits it via `onPick`. With no selection, the
 * dock is still browsable; clicks surface a hint to pick a cell first.
 *
 * Shares all body chrome (tabs / search / grid / tap-hold builder)
 * with the modal `KeycodePicker` via `PickerBody`. The only
 * difference is the surrounding header: the modal closes itself on
 * pick, the dock shows a persistent "selected cell" summary card.
 */

import type { KeyboardLayoutDef } from '../protocol/handshake';
import { labelForKeycode } from '../protocol/keycodes';
import { PickerBody } from './KeycodePicker';

export interface KeycodeDockProps {
  definition: KeyboardLayoutDef;
  layerCount: number;
  /** Active cell on the current layer, or null if nothing selected. */
  selected: { row: number; col: number } | null;
  /** Current keycode at the selected cell. Ignored when selected is null. */
  current: number;
  /** Optional hover-preview keycode (e.g. on hover over the keymap). */
  hover?: number | null;
  onPick: (keycode: number) => void;
}

export function KeycodeDock({
  definition,
  layerCount,
  selected,
  current,
  hover,
  onPick,
}: KeycodeDockProps) {
  const currentLabel = labelForKeycode(current, { definition });
  const hoverLabel =
    hover != null && hover !== current ? labelForKeycode(hover, { definition }) : null;

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-900">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            キーコードピッカー
          </h3>
          {selected ? (
            <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5 truncate">
              選択中:{' '}
              <span className="font-mono">
                行 {selected.row} 列 {selected.col}
              </span>
              <span className="mx-1.5 text-zinc-400">→</span>
              現在の割り当て:{' '}
              <span className="font-mono text-zinc-800 dark:text-zinc-200">
                {currentLabel.long}
              </span>
              <span className="text-zinc-400 ml-1">
                (0x{current.toString(16).padStart(4, '0')})
              </span>
            </p>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              キーマップ上のセルをクリックして編集対象を選択してください。
            </p>
          )}
          {hoverLabel && (
            <p className="text-[11px] text-sky-700 dark:text-sky-300 mt-0.5 truncate">
              プレビュー: <span className="font-mono">{hoverLabel.long}</span>
            </p>
          )}
        </div>
        {selected && (
          <div className="flex items-center gap-1.5">
            <KeycapPreview
              label={currentLabel.center || currentLabel.short || '—'}
              top={currentLabel.top}
              bottom={currentLabel.bottom}
            />
          </div>
        )}
      </header>
      <PickerBody
        definition={definition}
        layerCount={layerCount}
        onPick={onPick}
        maxHeight="50vh"
      />
    </div>
  );
}

interface KeycapPreviewProps {
  label: string;
  top?: string;
  bottom?: string;
}

function KeycapPreview({ label, top, bottom }: KeycapPreviewProps) {
  return (
    <div
      className="relative w-14 h-14 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-sm flex flex-col items-center justify-center"
      aria-hidden
    >
      {top && (
        <span className="absolute top-1 left-1 right-1 text-[9px] font-bold tracking-tight leading-none truncate text-center text-zinc-500 dark:text-zinc-400">
          {top}
        </span>
      )}
      <span className="text-sm font-medium leading-none text-zinc-900 dark:text-zinc-100 max-w-full truncate px-1">
        {label}
      </span>
      {bottom && (
        <span className="absolute bottom-1 left-1 right-1 text-[9px] leading-none text-zinc-500 dark:text-zinc-400 truncate text-center">
          {bottom}
        </span>
      )}
    </div>
  );
}
