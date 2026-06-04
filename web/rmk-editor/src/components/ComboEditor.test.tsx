import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { useComboStore } from '../state/combos';
import { ComboEditor } from './ComboEditor';

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

function prime(initial: Array<{ inputs: [number, number, number, number]; output: number }>) {
  useComboStore.setState({
    phase: { kind: 'ready' },
    transport: null,
    count: initial.length,
    baseline: initial.map((c) => ({
      inputs: [...c.inputs] as [number, number, number, number],
      output: c.output,
    })),
    local: initial.map((c) => ({
      inputs: [...c.inputs] as [number, number, number, number],
      output: c.output,
    })),
  });
}

beforeEach(() => {
  useComboStore.getState().detach();
});

describe('ComboEditor — empty slots', () => {
  it('renders a "+ 追加" affordance for each empty slot', () => {
    prime([
      { inputs: [0, 0, 0, 0], output: 0 },
      { inputs: [0, 0, 0, 0], output: 0 },
    ]);
    render(<ComboEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getAllByRole('button', { name: '＋ 追加' })).toHaveLength(2);
  });
});

describe('ComboEditor — populated slots', () => {
  beforeEach(() => {
    prime([
      { inputs: [0x14, 0x1a, 0, 0], output: 0x29 },
      { inputs: [0, 0, 0, 0], output: 0 },
    ]);
  });

  it('shows the input + output keycode buttons for non-empty entries', () => {
    render(<ComboEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.queryByText('Q')).not.toBeNull();
    expect(screen.queryByText('W')).not.toBeNull();
    expect(screen.queryByText('Esc')).not.toBeNull();
  });

  it('clear (×) button empties the slot', async () => {
    const user = userEvent.setup();
    render(<ComboEditor definition={DEFINITION} layerCount={4} />);
    const clear = screen.getAllByRole('button', { name: '削除' })[0] as HTMLElement;
    await user.click(clear);
    expect(useComboStore.getState().local[0]).toEqual({ inputs: [0, 0, 0, 0], output: 0 });
  });

  it('reset button restores the slot from baseline', async () => {
    useComboStore.getState().setOutput(0, 0x2a);
    expect(useComboStore.getState().local[0]?.output).toBe(0x2a);
    const user = userEvent.setup();
    render(<ComboEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(useComboStore.getState().local[0]?.output).toBe(0x29);
  });
});

describe('ComboEditor — duplicate detection', () => {
  it('marks duplicate-input combos with the warning chip', () => {
    prime([
      { inputs: [0x14, 0x1a, 0, 0], output: 0x29 },
      { inputs: [0x1a, 0x14, 0, 0], output: 0x2a }, // same input set, different order
      { inputs: [0x04, 0x05, 0, 0], output: 0x06 },
    ]);
    render(<ComboEditor definition={DEFINITION} layerCount={4} />);
    const warns = screen.getAllByText(/重複/);
    expect(warns.length).toBe(2);
  });
});

describe('ComboEditor — save button', () => {
  it('is disabled when no changes are pending', () => {
    prime([{ inputs: [0, 0, 0, 0], output: 0 }]);
    render(<ComboEditor definition={DEFINITION} layerCount={4} />);
    const save = screen.getByRole('button', { name: '保存済み' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables when local diverges from baseline', () => {
    prime([{ inputs: [0, 0, 0, 0], output: 0 }]);
    useComboStore.getState().setOutput(0, 0x29);
    render(<ComboEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByRole('button', { name: 'コンボを保存' })).toBeTruthy();
  });
});

describe('ComboEditor — loading state', () => {
  it('renders the loading placeholder when phase is empty', () => {
    useComboStore.setState({ phase: { kind: 'empty' }, count: 0, baseline: [], local: [] });
    render(<ComboEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByText(/読み込み中/)).toBeTruthy();
  });
});
