import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { USER_BASE } from '../protocol/keycodes';
import { BluetoothPanel } from './BluetoothPanel';

const DEFINITION: KeyboardLayoutDef = {
  matrix: { rows: 4, cols: 10 },
  layouts: { keymap: [] },
  customKeycodes: [
    { name: 'BT0', title: 'Bluetooth Channel 0', shortName: 'BT0' },
    { name: 'BT1', title: 'Bluetooth Channel 1', shortName: 'BT1' },
    { name: 'BT2', title: 'Bluetooth Channel 2', shortName: 'BT2' },
    { name: 'BT3', title: 'Bluetooth Channel 3', shortName: 'BT3' },
    { name: 'NEXT_BT', title: 'Next BT', shortName: 'Next\nBT' },
    { name: 'PREV_BT', title: 'Previous BT', shortName: 'Prev\nBT' },
    { name: 'CLR_BT', title: 'Clear BT bond', shortName: 'Clear\nBT' },
    { name: 'SWITCH', title: 'Switch output', shortName: 'Switch\nOutput' },
  ],
};

function makeLayer3({
  mapping,
}: {
  mapping: Partial<Record<number, { row: number; col: number }>>;
}): number[][] {
  const grid: number[][] = Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => 0));
  for (const [userIdxStr, pos] of Object.entries(mapping)) {
    if (!pos) continue;
    const userIdx = Number(userIdxStr);
    const row = grid[pos.row];
    if (row) row[pos.col] = USER_BASE + userIdx;
  }
  return grid;
}

describe('BluetoothPanel', () => {
  it('renders one card per BLE profile (0..3) and one per BLE control (User4..7)', () => {
    render(
      <BluetoothPanel
        definition={DEFINITION}
        layer3={makeLayer3({ mapping: {} })}
        onSelectCell={() => {}}
      />,
    );
    expect(screen.getByText('BLE プロファイル 0')).toBeInTheDocument();
    expect(screen.getByText('BLE プロファイル 3')).toBeInTheDocument();
    // BLE control cards — "Next BT" appears in both title and description so >=1 is enough.
    expect(screen.getAllByText('Next BT').length).toBeGreaterThan(0);
    expect(screen.getByText('Switch output')).toBeInTheDocument();
  });

  it('marks mapped profiles with 割当あり and unmapped with 未割当', () => {
    render(
      <BluetoothPanel
        definition={DEFINITION}
        layer3={makeLayer3({ mapping: { 0: { row: 0, col: 0 }, 2: { row: 0, col: 2 } } })}
        onSelectCell={() => {}}
      />,
    );
    const profile0 = screen.getByText('BLE プロファイル 0').closest('article');
    const profile1 = screen.getByText('BLE プロファイル 1').closest('article');
    if (!profile0 || !profile1) throw new Error('profile cards not found');
    expect(within(profile0).getByText('割当あり')).toBeInTheDocument();
    expect(within(profile1).getByText('未割当')).toBeInTheDocument();
  });

  it('locate-on-keymap button reports the matrix position to the parent', async () => {
    const onSelectCell = vi.fn();
    render(
      <BluetoothPanel
        definition={DEFINITION}
        layer3={makeLayer3({ mapping: { 0: { row: 0, col: 5 } } })}
        onSelectCell={onSelectCell}
      />,
    );
    const profile0 = screen.getByText('BLE プロファイル 0').closest('article');
    if (!profile0) throw new Error('profile 0 card missing');
    await userEvent.click(within(profile0).getByRole('button', { name: /キーマップで位置を表示/ }));
    expect(onSelectCell).toHaveBeenCalledWith({ layer: 3, row: 0, col: 5 });
  });

  it('shows "レイヤー 3 には未割当" on a BLE control card when the User keycode is not mapped', () => {
    render(
      <BluetoothPanel
        definition={DEFINITION}
        layer3={makeLayer3({ mapping: {} })}
        onSelectCell={() => {}}
      />,
    );
    const switchCard = screen.getByText('Switch output').closest('article');
    if (!switchCard) throw new Error('switch card missing');
    expect(within(switchCard).getByText('レイヤー 3 には未割当')).toBeInTheDocument();
  });

  it('uses the user-index fallback name when customKeycodes is missing entries', () => {
    const sparse: KeyboardLayoutDef = {
      ...DEFINITION,
      customKeycodes: [
        DEFINITION.customKeycodes?.[0] ?? { name: 'BT0', title: 'BT0', shortName: 'BT0' },
      ],
    };
    render(
      <BluetoothPanel
        definition={sparse}
        layer3={makeLayer3({ mapping: {} })}
        onSelectCell={() => {}}
      />,
    );
    expect(
      screen.getAllByText('このスロットには customKeycode 情報がありません。').length,
    ).toBeGreaterThan(0);
  });
});
