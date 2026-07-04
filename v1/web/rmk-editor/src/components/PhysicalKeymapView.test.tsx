import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { PhysicalKeymapView } from './PhysicalKeymapView';

const DEFINITION: KeyboardLayoutDef = {
  matrix: { rows: 4, cols: 10 },
  customKeycodes: [{ name: 'BT0', title: 'Bluetooth Channel 0', shortName: 'BT0' }],
  layouts: { keymap: [] },
};

function uniformKeymap(code: number): number[][] {
  return Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => code));
}

function renderView(overrides: Partial<Parameters<typeof PhysicalKeymapView>[0]> = {}) {
  const props = {
    definition: DEFINITION,
    keymap: uniformKeymap(0x04), // すべて "A"
    selected: null,
    isDirty: () => false,
    onCellClick: vi.fn(),
    onBallClick: vi.fn(),
    ...overrides,
  };
  const utils = render(<PhysicalKeymapView {...props} />);
  return { ...utils, props };
}

describe('PhysicalKeymapView', () => {
  it('renders all 38 keys and both trackballs', () => {
    renderView();
    expect(screen.getAllByLabelText(/^行 \d+ 列 \d+:/)).toHaveLength(38);
    expect(screen.getByLabelText('左トラックボール（スクロール）の設定')).toBeInTheDocument();
    expect(screen.getByLabelText('右トラックボール（ポインタ）の設定')).toBeInTheDocument();
    // 全キーがキーコードラベル "A" を表示。
    expect(screen.getAllByText('A')).toHaveLength(38);
  });

  it('does not render the phantom thumb slots (3,0) / (3,9)', () => {
    renderView();
    expect(screen.queryByLabelText(/^行 3 列 0:/)).toBeNull();
    expect(screen.queryByLabelText(/^行 3 列 9:/)).toBeNull();
  });

  it('reports clicks with the matrix (row, col)', async () => {
    const { props } = renderView();
    await userEvent.click(screen.getByLabelText(/^行 0 列 0:/));
    expect(props.onCellClick).toHaveBeenCalledWith(0, 0);
    await userEvent.click(screen.getByLabelText(/^行 3 列 5:/));
    expect(props.onCellClick).toHaveBeenCalledWith(3, 5);
  });

  it('reports trackball clicks with the side', async () => {
    const { props } = renderView();
    await userEvent.click(screen.getByLabelText('右トラックボール（ポインタ）の設定'));
    expect(props.onBallClick).toHaveBeenCalledWith('right');
    await userEvent.click(screen.getByLabelText('左トラックボール（スクロール）の設定'));
    expect(props.onBallClick).toHaveBeenCalledWith('left');
  });

  it('marks the selected cell and the selected ball with aria-pressed', () => {
    renderView({ selected: { row: 1, col: 2 }, selectedBall: 'left' });
    expect(screen.getByLabelText(/^行 1 列 2:/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/^行 0 列 0:/)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('左トラックボール（スクロール）の設定')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the dirty marker only on dirty cells', () => {
    renderView({ isDirty: (row, col) => row === 0 && col === 1 });
    expect(screen.getAllByTitle('未保存の変更あり')).toHaveLength(1);
  });

  it('pulses the unlock chord cells while chordActive', () => {
    renderView({
      chordCells: [
        { row: 0, col: 0 },
        { row: 0, col: 9 },
      ],
      chordActive: true,
    });
    expect(screen.getByLabelText(/^行 0 列 0:/).className).toContain('animate-pulse');
    expect(screen.getByLabelText(/^行 0 列 9:/).className).toContain('animate-pulse');
    expect(screen.getByLabelText(/^行 1 列 0:/).className).not.toContain('animate-pulse');
  });

  it('rotates thumb keys via inline transform', () => {
    renderView();
    const innerLeftThumb = screen.getByLabelText(/^行 3 列 4:/);
    expect(innerLeftThumb.style.transform).toBe('rotate(30deg)');
    const innerRightThumb = screen.getByLabelText(/^行 3 列 5:/);
    expect(innerRightThumb.style.transform).toBe('rotate(-30deg)');
    const outerLeftThumb = screen.getByLabelText(/^行 3 列 1:/);
    expect(outerLeftThumb.style.transform).toBe('rotate(0deg)');
  });

  it('notifies hover enter/leave through onCellHover', async () => {
    const onCellHover = vi.fn();
    renderView({ onCellHover });
    await userEvent.hover(screen.getByLabelText(/^行 2 列 3:/));
    expect(onCellHover).toHaveBeenCalledWith({ row: 2, col: 3 });
  });
});

describe('PhysicalKeymapView with a kobu2 (v2) definition', () => {
  // kobu2 は definition の productId (デバイス自己申告) で判定され、
  // 小指列最下段の (3,0)/(3,9) が実キーとして描画される。
  const KOBU2_DEFINITION: KeyboardLayoutDef = { ...DEFINITION, productId: '0x425A' };

  it('renders 40 keys including the bottom-pinky pair (3,0)/(3,9)', () => {
    renderView({ definition: KOBU2_DEFINITION });
    expect(screen.getAllByLabelText(/^行 \d+ 列 \d+:/)).toHaveLength(40);
    expect(screen.getByLabelText(/^行 3 列 0:/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^行 3 列 9:/)).toBeInTheDocument();
  });

  it('reports clicks on the new keys with their matrix position', async () => {
    const { props } = renderView({ definition: KOBU2_DEFINITION });
    await userEvent.click(screen.getByLabelText(/^行 3 列 0:/));
    expect(props.onCellClick).toHaveBeenCalledWith(3, 0);
    await userEvent.click(screen.getByLabelText(/^行 3 列 9:/));
    expect(props.onCellClick).toHaveBeenCalledWith(3, 9);
  });
});
