import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { useMorseStore } from '../state/morses';
import { MorseEditor } from './MorseEditor';

const DEFINITION: KeyboardLayoutDef = {
  matrix: { rows: 4, cols: 10 },
  customKeycodes: [],
  layouts: {
    keymap: [
      ['0,0', '0,1', '0,2', '0,3', '0,4', { x: 1 }, '0,5', '0,6', '0,7', '0,8', '0,9'],
      ['1,0', '1,1', '1,2', '1,3', '1,4', { x: 1 }, '1,5', '1,6', '1,7', '1,8', '1,9'],
      ['2,0', '2,1', '2,2', '2,3', '2,4', { x: 1 }, '2,5', '2,6', '2,7', '2,8', '2,9'],
      [{ x: 1 }, '3,1', '3,2', '3,3', '3,4', { x: 1 }, '3,5', '3,6', '3,7', '3,8'],
    ],
  },
};

function prime(
  initial: Array<{
    tap: number;
    hold: number;
    doubleTap: number;
    holdAfterTap: number;
    tapTermMs: number;
  }>,
) {
  useMorseStore.setState({
    phase: { kind: 'ready' },
    transport: null,
    count: initial.length,
    baseline: initial.map((e) => ({ ...e })),
    local: initial.map((e) => ({ ...e })),
  });
}

beforeEach(() => {
  useMorseStore.getState().detach();
});

describe('MorseEditor', () => {
  it('renders one card per slot, each with 4 field buttons and a tap-term input', () => {
    prime([
      { tap: 0, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 },
      { tap: 0x0d, hold: 0x00e0, doubleTap: 0x0029, holdAfterTap: 0, tapTermMs: 200 },
    ]);
    render(<MorseEditor definition={DEFINITION} layerCount={4} />);
    // Two TD(N) labels
    expect(screen.getByText('TD(0)')).toBeTruthy();
    expect(screen.getByText('TD(1)')).toBeTruthy();
    // Field labels appear on every card → 8 of each
    expect(screen.getAllByText('タップ')).toHaveLength(2);
    expect(screen.getAllByText('ホールド')).toHaveLength(2);
    // Tap-term inputs: two of them
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
  });

  it('shows the "未設定" hint for the all-zero entry', () => {
    prime([{ tap: 0, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 }]);
    render(<MorseEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByText(/未設定/)).toBeTruthy();
  });

  it('tap-term input commits to the store', async () => {
    prime([{ tap: 0x0d, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 }]);
    const user = userEvent.setup();
    render(<MorseEditor definition={DEFINITION} layerCount={4} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '250');
    expect(useMorseStore.getState().local[0]?.tapTermMs).toBe(250);
  });

  it('out-of-range tap term renders the rose warning', () => {
    prime([{ tap: 0x0d, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 20 }]);
    render(<MorseEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByText(/推奨範囲は/)).toBeTruthy();
  });

  it('clear (×) button empties the slot', async () => {
    prime([{ tap: 0x0d, hold: 0x00e0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 }]);
    const user = userEvent.setup();
    render(<MorseEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('button', { name: 'クリア' }));
    expect(useMorseStore.getState().local[0]?.tap).toBe(0);
    expect(useMorseStore.getState().local[0]?.hold).toBe(0);
  });

  it('save button is disabled when nothing is dirty', () => {
    prime([{ tap: 0, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 }]);
    render(<MorseEditor definition={DEFINITION} layerCount={4} />);
    const save = screen.getByRole('button', { name: '保存済み' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the preset menu and applies a preset', async () => {
    prime([{ tap: 0, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 }]);
    const user = userEvent.setup();
    render(<MorseEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('button', { name: /テンプレート/ }));
    await user.click(screen.getByRole('menuitem', { name: /Esc.*Ctrl/ }));
    expect(useMorseStore.getState().local[0]?.hold).toBe(0x00e0);
  });

  it('renders the loading placeholder when phase is empty', () => {
    useMorseStore.setState({ phase: { kind: 'empty' }, count: 0, baseline: [], local: [] });
    render(<MorseEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByText(/読み込み中/)).toBeTruthy();
  });
});
