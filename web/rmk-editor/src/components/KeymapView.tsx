/**
 * Keymap renderer.
 *
 * Renders the firmware-supplied `layouts.keymap` from `vial.json` as a
 * grid of HTML `<button>` keycaps positioned absolutely within a
 * matrix-unit-sized container. Each keycap carries:
 *   - a centred "tap" label (big)
 *   - an optional small "hold / modifier" badge along the top
 *   - an optional small bottom hint (alt glyph)
 *
 * The structured label and `accent` tint come from
 * `protocol/keycodes.ts::labelForKeycode`, so visual treatment stays
 * consistent across the editor.
 *
 * Click events flow up via `onCellClick(row, col)`; the picker / save
 * flow live in the parent component, so the renderer is stateless and
 * trivially testable in isolation.
 *
 * `buildCells` is exported for unit tests in `KeymapView.test.tsx`.
 */

import { useMemo } from 'react';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { type KeyLabel, labelForKeycode } from '../protocol/keycodes';

const UNIT = 56;
const GAP = 4;
const PADDING = 12;

export type LayoutEntry = string | { x?: number; y?: number; w?: number; h?: number };

interface Cell {
  row: number;
  col: number;
  /** Top-left x in matrix units (column slot, including skips). */
  x: number;
  /** Top-left y in matrix units. */
  y: number;
  /** Width in units. */
  w: number;
  /** Height in units. */
  h: number;
}

export interface KeymapViewProps {
  definition: KeyboardLayoutDef;
  /** Layer slice: `keymap[row][col]` of u16 keycodes. */
  keymap: number[][];
  selected: { row: number; col: number } | null;
  isDirty: (row: number, col: number) => boolean;
  onCellClick: (row: number, col: number) => void;
  /** Optional hover callback — receives the cell or null when leaving. */
  onCellHover?: (cell: { row: number; col: number } | null) => void;
  /**
   * Physical (row, col) keys to spotlight — e.g. the Vial unlock chord, so
   * the user can see which keys to hold. Highlighted (pulsing) only while
   * `chordActive` is true.
   */
  chordCells?: ReadonlyArray<{ row: number; col: number }>;
  chordActive?: boolean;
}

export function KeymapView({
  definition,
  keymap,
  selected,
  isDirty,
  onCellClick,
  onCellHover,
  chordCells,
  chordActive = false,
}: KeymapViewProps) {
  const midCol = Math.floor(definition.matrix.cols / 2);
  const cells = useMemo(
    () =>
      buildCells(definition.layouts.keymap as ReadonlyArray<ReadonlyArray<LayoutEntry>>, {
        midCol,
        snapToCol: true,
      }),
    [definition.layouts.keymap, midCol],
  );
  const { width, height } = useMemo(() => layoutExtent(cells), [cells]);
  const midlineX = useMemo(() => computeMidlineX(cells, midCol), [cells, midCol]);

  return (
    <div className="w-full overflow-x-auto">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: matrix-positioned keycap grid; interactions live on each <button> child, the wrapper only catches mouseleave to clear hover state */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label functions as a region label for the keymap grid */}
      <div
        aria-label="kobu キーマップ"
        className="relative select-none mx-auto"
        style={{ width: `${width}px`, height: `${height}px` }}
        onMouseLeave={() => onCellHover?.(null)}
      >
        {midlineX !== null && (
          <div
            aria-hidden
            className="absolute top-2 bottom-2 w-px border-l border-dashed border-zinc-300 dark:border-zinc-700"
            style={{ left: `${midlineX}px` }}
          />
        )}
        {cells.map((cell) => {
          const value = keymap[cell.row]?.[cell.col] ?? 0;
          const label = labelForKeycode(value, { definition });
          const isSelected =
            selected !== null && selected.row === cell.row && selected.col === cell.col;
          const dirty = isDirty(cell.row, cell.col);
          const isChord =
            chordActive === true &&
            chordCells?.some((c) => c.row === cell.row && c.col === cell.col) === true;
          return (
            <Keycap
              key={`${cell.row}-${cell.col}`}
              cell={cell}
              label={label}
              selected={isSelected}
              dirty={dirty}
              chord={isChord}
              onClick={() => onCellClick(cell.row, cell.col)}
              onMouseEnter={() => onCellHover?.({ row: cell.row, col: cell.col })}
            />
          );
        })}
      </div>
    </div>
  );
}

interface KeycapProps {
  cell: Cell;
  label: KeyLabel;
  selected: boolean;
  dirty: boolean;
  chord?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
}

function Keycap({
  cell,
  label,
  selected,
  dirty,
  chord = false,
  onClick,
  onMouseEnter,
}: KeycapProps) {
  const left = PADDING + cell.x * UNIT + GAP / 2;
  const top = PADDING + cell.y * UNIT + GAP / 2;
  const w = cell.w * UNIT - GAP;
  const h = cell.h * UNIT - GAP;

  return (
    <button
      type="button"
      aria-label={`行 ${cell.row} 列 ${cell.col}: ${label.long}`}
      aria-pressed={selected}
      title={label.long}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onFocus={onMouseEnter}
      className={[
        'absolute flex flex-col items-center justify-center',
        'rounded-lg border text-zinc-900 dark:text-zinc-50',
        'transition-[transform,box-shadow,background-color] duration-100',
        'shadow-sm hover:-translate-y-px hover:shadow-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-50 dark:focus-visible:ring-offset-zinc-950',
        cellTone(label.tone),
        selected
          ? 'ring-2 ring-sky-500 ring-offset-1 ring-offset-zinc-50 dark:ring-offset-zinc-950 -translate-y-px shadow-md'
          : '',
        chord
          ? 'ring-2 ring-amber-500 ring-offset-1 ring-offset-zinc-50 dark:ring-offset-zinc-950 motion-safe:animate-pulse z-10'
          : '',
      ].join(' ')}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${w}px`,
        height: `${h}px`,
      }}
    >
      {label.top !== '' && (
        <span
          className={[
            'absolute left-1 right-1 top-1 text-[9px] font-bold tracking-tight leading-none',
            'truncate text-center pointer-events-none',
            accentText(label.accent),
          ].join(' ')}
        >
          {label.top}
        </span>
      )}
      <span
        className={[
          'pointer-events-none font-medium leading-none text-center px-0.5',
          centerSize(label.center),
          label.tone === 'muted' ? 'text-zinc-400 dark:text-zinc-600' : '',
        ].join(' ')}
      >
        {label.center}
      </span>
      {label.bottom !== '' && (
        <span className="absolute bottom-1 left-1 right-1 text-[9px] leading-none text-zinc-500 dark:text-zinc-400 truncate text-center pointer-events-none">
          {label.bottom}
        </span>
      )}
      {dirty && (
        <span
          title="未保存の変更あり"
          className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-zinc-50 dark:ring-zinc-950"
        />
      )}
    </button>
  );
}

function centerSize(text: string): string {
  if (text.length <= 1) return 'text-lg';
  if (text.length <= 2) return 'text-base';
  if (text.length <= 4) return 'text-sm';
  if (text.length <= 6) return 'text-xs';
  return 'text-[10px]';
}

function cellTone(tone: KeyLabel['tone']): string {
  switch (tone) {
    case 'muted':
      return 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800';
    case 'layer':
      return 'bg-indigo-50 dark:bg-indigo-950/60 border-indigo-200 dark:border-indigo-900';
    case 'mod':
      return 'bg-violet-50 dark:bg-violet-950/60 border-violet-200 dark:border-violet-900';
    case 'user':
      return 'bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-900';
    case 'mouse':
      return 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-900';
    case 'media':
      return 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-900';
    case 'other':
      return 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700';
    default:
      return 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700';
  }
}

function accentText(accent: KeyLabel['accent']): string {
  switch (accent) {
    case 'mod':
      return 'text-violet-700 dark:text-violet-300';
    case 'layer':
      return 'text-indigo-700 dark:text-indigo-300';
    case 'tap-hold':
      return 'text-sky-700 dark:text-sky-300';
    case 'special':
      return 'text-zinc-600 dark:text-zinc-400';
    default:
      return 'text-zinc-500 dark:text-zinc-400';
  }
}

export interface BuildCellsOptions {
  /**
   * Column index where the right half starts (cols < midCol are left,
   * cols >= midCol are right). Used to enforce a minimum visual gap
   * between the two halves on every row — vial.json's thumb row
   * declares `{x: 0}` instead of the letter rows' `{x: 1}`, so without
   * this injection the thumb cluster renders as a single uninterrupted
   * strip with no visible split.
   */
  midCol?: number;
  /** Units of gap to inject when the row crosses the midline too tightly. */
  midGap?: number;
  /**
   * When true, ignore the `{x: N}` cursor advances in vial.json and
   * deterministically place each cell at `x = col` on the left half
   * and `x = col + midGap` on the right half. This makes the rendered
   * layout immune to vial.json indent/gap mistakes — the cells line
   * up with their col index regardless of what the firmware embedded.
   * Used in production via the KeymapView component to recover from
   * older firmware that ships an off-by-N thumb row indent.
   *
   * `midCol` must be set for the right-half offset to apply; without
   * it the cells just sit at x=col.
   */
  snapToCol?: boolean;
}

/**
 * Walk the vial.json `layouts.keymap` shape and emit one Cell per
 * "r,c" string. `{x:N}` slides the cursor right by N units.
 *
 * Additionally, when a row transitions from a left-half cell (col <
 * midCol) to a right-half cell (col >= midCol) with insufficient
 * separation, an extra gap is injected so the split halves stay
 * visually distinct. Rows that already declare an explicit `{x: 1}`
 * gap (the letter rows) are unaffected — the injection only kicks in
 * if the existing separation is below `midGap`.
 *
 * With `snapToCol: true`, the cursor-walking logic is bypassed
 * entirely: each cell is placed at its column index (+ midGap on the
 * right half). This produces a deterministic, vial.json-agnostic
 * layout and is what KeymapView uses in production.
 */
export function buildCells(
  rows: ReadonlyArray<ReadonlyArray<LayoutEntry>>,
  options: BuildCellsOptions = {},
): Cell[] {
  const { midCol, midGap = 1, snapToCol = false } = options;
  if (snapToCol) {
    const cells: Cell[] = [];
    rows.forEach((entries, rowIndex) => {
      for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        const [r, c] = entry.split(',').map((n) => Number(n));
        if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
        const row = r ?? 0;
        const col = c ?? 0;
        const x = midCol !== undefined && col >= midCol ? col + midGap : col;
        cells.push({ row, col, x, y: rowIndex, w: 1, h: 1 });
      }
    });
    return cells;
  }
  const cells: Cell[] = [];
  rows.forEach((entries, rowIndex) => {
    let cursorX = 0;
    let cellW = 1;
    let cellH = 1;
    let lastLeftRightEdge: number | null = null;
    let gapInjected = false;
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const [r, c] = entry.split(',').map((n) => Number(n));
        if (Number.isFinite(r) && Number.isFinite(c)) {
          const row = r ?? 0;
          const col = c ?? 0;
          if (midCol !== undefined && !gapInjected && lastLeftRightEdge !== null && col >= midCol) {
            const minStart = lastLeftRightEdge + midGap;
            if (cursorX < minStart) {
              cursorX = minStart;
            }
            gapInjected = true;
          }
          cells.push({ row, col, x: cursorX, y: rowIndex, w: cellW, h: cellH });
          if (midCol !== undefined && col < midCol) {
            lastLeftRightEdge = cursorX + cellW;
          }
        }
        cursorX += cellW;
        cellW = 1;
        cellH = 1;
      } else {
        if (typeof entry.x === 'number') cursorX += entry.x;
        if (typeof entry.w === 'number') cellW = entry.w;
        if (typeof entry.h === 'number') cellH = entry.h;
      }
    }
  });
  return cells;
}

function layoutExtent(cells: Cell[]): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  for (const c of cells) {
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  return {
    width: PADDING * 2 + maxX * UNIT,
    height: PADDING * 2 + maxY * UNIT,
  };
}

/**
 * Pixel X of the dashed midline divider. Returns the midpoint of the
 * widest gap between any left-half cell's right edge and any right-half
 * cell's left edge across the whole keymap. Returns `null` when the
 * layout has no clear split.
 */
function computeMidlineX(cells: Cell[], midCol: number): number | null {
  let leftMaxEdge = -Infinity;
  let rightMinEdge = Infinity;
  for (const c of cells) {
    if (c.col < midCol) {
      leftMaxEdge = Math.max(leftMaxEdge, c.x + c.w);
    } else {
      rightMinEdge = Math.min(rightMinEdge, c.x);
    }
  }
  if (!Number.isFinite(leftMaxEdge) || !Number.isFinite(rightMinEdge)) return null;
  if (rightMinEdge <= leftMaxEdge) return null;
  const midUnits = (leftMaxEdge + rightMinEdge) / 2;
  return PADDING + midUnits * UNIT;
}
