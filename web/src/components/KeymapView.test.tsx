import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { buildCells, KeymapView, type LayoutEntry } from './KeymapView';

const kobuLayout: KeyboardLayoutDef = {
  matrix: { rows: 4, cols: 10 },
  customKeycodes: [{ name: 'BT0', title: 'Bluetooth Channel 0', shortName: 'BT0' }],
  layouts: {
    keymap: [
      ['0,0', '0,1', '0,2', '0,3', '0,4', { x: 1 }, '0,5', '0,6', '0,7', '0,8', '0,9'],
      ['1,0', '1,1', '1,2', '1,3', '1,4', { x: 1 }, '1,5', '1,6', '1,7', '1,8', '1,9'],
      ['2,0', '2,1', '2,2', '2,3', '2,4', { x: 1 }, '2,5', '2,6', '2,7', '2,8', '2,9'],
      [{ x: 3 }, '3,1', '3,2', '3,3', '3,4', { x: 0 }, '3,5', '3,6', '3,7', '3,8'],
    ],
  },
};

describe('buildCells', () => {
  it('emits one cell per "r,c" entry, respecting `{x: N}` skips', () => {
    const layout = kobuLayout.layouts.keymap as ReadonlyArray<ReadonlyArray<LayoutEntry>>;
    const cells = buildCells(layout);
    // 10 + 10 + 10 + 8 = 38 cells (phantom thumbs at (3,0) and (3,9) are missing)
    expect(cells.length).toBe(38);

    // Right-half row 0 must start 6 units in (5 letters + 1-unit gap).
    const cellR0C5 = cells.find((c) => c.row === 0 && c.col === 5);
    expect(cellR0C5?.x).toBe(6);
  });

  it('keeps the thumb row aligned with the inner-cluster offset', () => {
    const layout = kobuLayout.layouts.keymap as ReadonlyArray<ReadonlyArray<LayoutEntry>>;
    const cells = buildCells(layout);
    const r3c1 = cells.find((c) => c.row === 3 && c.col === 1);
    expect(r3c1?.x).toBe(3);
    const r3c5 = cells.find((c) => c.row === 3 && c.col === 5);
    expect(r3c5?.x).toBe(7);
  });

  it('injects a midline gap on the thumb row when midCol is supplied', () => {
    const layout = kobuLayout.layouts.keymap as ReadonlyArray<ReadonlyArray<LayoutEntry>>;
    const cells = buildCells(layout, { midCol: 5 });

    // Letter row already has an explicit 1-unit gap — no injection.
    expect(cells.find((c) => c.row === 0 && c.col === 5)?.x).toBe(6);

    // Thumb row had {x:0}, so the renderer is responsible for the gap.
    // Last left-half thumb (3,4) ends at x=7; right half should start at x=8.
    expect(cells.find((c) => c.row === 3 && c.col === 4)?.x).toBe(6);
    expect(cells.find((c) => c.row === 3 && c.col === 5)?.x).toBe(8);
  });

  it('accepts a custom midGap', () => {
    const layout = kobuLayout.layouts.keymap as ReadonlyArray<ReadonlyArray<LayoutEntry>>;
    const cells = buildCells(layout, { midCol: 5, midGap: 2 });
    expect(cells.find((c) => c.row === 3 && c.col === 5)?.x).toBe(9);
  });
});

describe('KeymapView', () => {
  function fullKeymap(value: number): number[][] {
    return Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => value));
  }

  it('fires onCellClick with the matrix coordinates', () => {
    const onCellClick = vi.fn();
    render(
      <KeymapView
        definition={kobuLayout}
        keymap={fullKeymap(0x04)}
        selected={null}
        isDirty={() => false}
        onCellClick={onCellClick}
      />,
    );
    const target = screen.getByLabelText(/行 0 列 5: A/);
    fireEvent.click(target);
    expect(onCellClick).toHaveBeenCalledWith(0, 5);
  });

  it('renders the kobu customKeycode label for User0', () => {
    const km = fullKeymap(0x7e00);
    render(
      <KeymapView
        definition={kobuLayout}
        keymap={km}
        selected={null}
        isDirty={() => false}
        onCellClick={() => {}}
      />,
    );
    expect(screen.getAllByText('BT0').length).toBeGreaterThan(0);
  });
});
