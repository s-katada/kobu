/**
 * SVG keymap renderer.
 *
 * Reads the firmware-supplied `layouts.keymap` from `vial.json` and
 * paints each cell at its declared row/col, honouring `{x: N}` skips
 * (split gap + phantom slots) by advancing the cursor without
 * emitting a rect.
 *
 * Click events flow up via `onCellClick(row, col)` — the picker / save
 * flow live in the parent component, not here. This keeps the SVG
 * stateless and trivially testable in isolation.
 */

import { useMemo } from 'react';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { type KeyLabel, labelForKeycode } from '../protocol/keycodes';

const UNIT = 56; // px per matrix unit
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
}

export function KeymapView({
  definition,
  keymap,
  selected,
  isDirty,
  onCellClick,
}: KeymapViewProps) {
  const midCol = Math.floor(definition.matrix.cols / 2);
  const cells = useMemo(
    () =>
      buildCells(definition.layouts.keymap as ReadonlyArray<ReadonlyArray<LayoutEntry>>, {
        midCol,
      }),
    [definition.layouts.keymap, midCol],
  );
  const { width, height } = useMemo(() => layoutExtent(cells), [cells]);
  const midlineX = useMemo(() => computeMidlineX(cells, midCol), [cells, midCol]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      aria-label="kobu キーマップ"
      className="w-full h-auto max-h-[60vh] select-none"
    >
      <defs>
        <filter id="keycap-shadow" x="-10%" y="-10%" width="120%" height="130%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="0.6" />
          <feOffset dy="1" />
          <feComposite in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.18 0" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {midlineX !== null && (
        <line
          x1={midlineX}
          x2={midlineX}
          y1={PADDING / 2}
          y2={height - PADDING / 2}
          stroke="#d4d4d8"
          strokeDasharray="4 4"
          strokeWidth={1}
          aria-hidden
        />
      )}
      {cells.map((cell) => {
        const value = keymap[cell.row]?.[cell.col] ?? 0;
        const label = labelForKeycode(value, { definition });
        const isSelected =
          selected !== null && selected.row === cell.row && selected.col === cell.col;
        const dirty = isDirty(cell.row, cell.col);
        return (
          <KeyCell
            key={`${cell.row}-${cell.col}`}
            cell={cell}
            label={label}
            selected={isSelected}
            dirty={dirty}
            onClick={() => onCellClick(cell.row, cell.col)}
          />
        );
      })}
    </svg>
  );
}

interface KeyCellProps {
  cell: Cell;
  label: KeyLabel;
  selected: boolean;
  dirty: boolean;
  onClick: () => void;
}

function KeyCell({ cell, label, selected, dirty, onClick }: KeyCellProps) {
  const x = PADDING + cell.x * UNIT + GAP / 2;
  const y = PADDING + cell.y * UNIT + GAP / 2;
  const w = cell.w * UNIT - GAP;
  const h = cell.h * UNIT - GAP;

  const fill = toneFill(label.tone);
  const stroke = selected ? '#2563eb' : '#d4d4d8';
  const strokeWidth = selected ? 2 : 1;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: SVG <g> with aria-label + keyboard handler — semantic buttons inside SVG would distort layout
    <g
      aria-label={`行 ${cell.row} 列 ${cell.col}: ${label.long}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="cursor-pointer focus:outline-none"
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        ry={6}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        filter="url(#keycap-shadow)"
        className="transition-colors hover:fill-zinc-100 dark:hover:fill-zinc-700"
      />
      <text
        x={x + w / 2}
        y={y + h / 2}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSizeFor(label.short)}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill={textFill(label.tone)}
        className="pointer-events-none"
      >
        {label.short}
      </text>
      {dirty && (
        <circle
          cx={x + w - 6}
          cy={y + 6}
          r={3}
          fill="#f59e0b"
          stroke="#fff"
          strokeWidth={0.8}
          aria-label="未保存の変更あり"
        />
      )}
    </g>
  );
}

function fontSizeFor(short: string): number {
  if (short.length <= 1) return 22;
  if (short.length <= 2) return 18;
  if (short.length <= 4) return 14;
  if (short.length <= 6) return 12;
  return 10;
}

function toneFill(tone: KeyLabel['tone']): string {
  switch (tone) {
    case 'muted':
      return '#fafafa';
    case 'layer':
      return '#dbeafe';
    case 'mod':
      return '#e9d5ff';
    case 'user':
      return '#fef3c7';
    case 'mouse':
      return '#dcfce7';
    case 'media':
      return '#fce7f3';
    case 'other':
      return '#f3f4f6';
    default:
      return '#ffffff';
  }
}

function textFill(tone: KeyLabel['tone']): string {
  return tone === 'muted' ? '#a1a1aa' : '#18181b';
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
 */
export function buildCells(
  rows: ReadonlyArray<ReadonlyArray<LayoutEntry>>,
  options: BuildCellsOptions = {},
): Cell[] {
  const { midCol, midGap = 1 } = options;
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
