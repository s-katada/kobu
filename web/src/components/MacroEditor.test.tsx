import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { useMacroStore } from '../state/macros';
import { MacroEditor } from './MacroEditor';

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

function primeStore(initialPhase: 'ready' | 'empty' = 'ready') {
  // Bypass `attach()` by setting state directly — keeps the tests
  // transport-free.
  useMacroStore.setState({
    phase: initialPhase === 'ready' ? { kind: 'ready' } : { kind: 'empty' },
    transport: null,
    count: 4,
    bufferSize: 64,
    baseline: [[], [], [], []],
    local: [[], [], [], []],
    activeIndex: 0,
  });
}

beforeEach(() => {
  useMacroStore.getState().detach();
});

describe('MacroEditor — connection/loading states', () => {
  it('renders a loading placeholder when the store is empty', () => {
    primeStore('empty');
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByText(/読み込み中/)).toBeTruthy();
  });

  it('renders an empty-state hint when ready with no actions', () => {
    primeStore('ready');
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByText(/アクションを追加して開始/)).toBeTruthy();
  });
});

describe('MacroEditor — macro list', () => {
  it('renders one tab per macro slot and marks the active one', () => {
    primeStore('ready');
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    const tablist = screen.getByRole('tablist', { name: 'マクロ一覧' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.length).toBe(4);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('switching tabs updates the active index in the store', async () => {
    primeStore('ready');
    const user = userEvent.setup();
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('tab', { name: /M2/ }));
    expect(useMacroStore.getState().activeIndex).toBe(2);
  });
});

describe('MacroEditor — action editing', () => {
  beforeEach(() => {
    primeStore('ready');
  });

  it('add-tap appends a Tap action and shows it in the list', async () => {
    const user = userEvent.setup();
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('button', { name: '＋ Tap' }));
    const local = useMacroStore.getState().local;
    expect(local[0]).toHaveLength(1);
    expect(local[0]?.[0]).toEqual({ kind: 'tap', keycode: 0x04 });
  });

  it('add-delay appends a Delay action with the default 30ms', async () => {
    const user = userEvent.setup();
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('button', { name: '＋ Delay' }));
    expect(useMacroStore.getState().local[0]).toEqual([{ kind: 'delay', ms: 30 }]);
    const spin = screen.getByRole('spinbutton');
    expect((spin as HTMLInputElement).value).toBe('30');
  });

  it('changing the action-type select migrates the kind in place', async () => {
    primeStore('ready');
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    const user = userEvent.setup();
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'アクション種別' }), 'down');
    expect(useMacroStore.getState().local[0]?.[0]).toEqual({ kind: 'down', keycode: 0x04 });
  });

  it('remove deletes the action from the sequence', async () => {
    primeStore('ready');
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    const user = userEvent.setup();
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('button', { name: '削除' }));
    expect(useMacroStore.getState().local[0]).toEqual([]);
  });

  it('reorder buttons move actions up and down', async () => {
    primeStore('ready');
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x05 });
    const user = userEvent.setup();
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    const downButtons = screen.getAllByRole('button', { name: '下へ' });
    await user.click(downButtons[0] as HTMLElement);
    expect(useMacroStore.getState().local[0]).toEqual([
      { kind: 'tap', keycode: 0x05 },
      { kind: 'tap', keycode: 0x04 },
    ]);
  });
});

describe('MacroEditor — buffer usage and save button', () => {
  it('shows the byte counter and 保存 button is disabled when not dirty', () => {
    primeStore('ready');
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByText(/4 \/ 64 B/)).toBeTruthy(); // 4 macros × 1B terminator
    const save = screen.getByRole('button', { name: '保存済み' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('保存 button enables once an action is added (dirty)', async () => {
    primeStore('ready');
    const user = userEvent.setup();
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('button', { name: '＋ Tap' }));
    expect(screen.getByRole('button', { name: 'マクロを保存' })).toBeTruthy();
  });

  it('reset restores the active macro from baseline', async () => {
    primeStore('ready');
    useMacroStore.setState({
      baseline: [[{ kind: 'tap', keycode: 0x04 }], [], [], []],
      local: [[{ kind: 'tap', keycode: 0x05 }], [], [], []],
    });
    const user = userEvent.setup();
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    await user.click(screen.getByRole('button', { name: 'このマクロを元に戻す' }));
    expect(useMacroStore.getState().local[0]).toEqual([{ kind: 'tap', keycode: 0x04 }]);
  });

  it('shows error message when the phase is error', () => {
    primeStore('ready');
    act(() => {
      useMacroStore.setState({ phase: { kind: 'error', message: 'デバイスがロックされています' } });
    });
    render(<MacroEditor definition={DEFINITION} layerCount={4} />);
    expect(screen.getByText(/デバイスがロックされています/)).toBeTruthy();
  });
});
