import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KOBU_VALUES, type KobuSettingKey } from '../protocol/customValue';
import { useKobuSettingsStore } from '../state/kobuSettings';
import { TrackballDock } from './TrackballDock';

function defaults(): Record<KobuSettingKey, number> {
  const out = {} as Record<KobuSettingKey, number>;
  for (const def of KOBU_VALUES) out[def.key] = def.default;
  return out;
}

describe('TrackballDock', () => {
  beforeEach(() => {
    useKobuSettingsStore.setState({
      phase: { kind: 'ready' },
      transport: null,
      baseline: defaults(),
      local: defaults(),
    });
  });

  it('right ball: shows pointer settings and the mouse-layer shortcut', () => {
    const onEditMouseLayer = vi.fn();
    render(<TrackballDock side="right" onClose={() => {}} onEditMouseLayer={onEditMouseLayer} />);

    expect(screen.getByText('右トラックボール')).toBeInTheDocument();
    expect(screen.getByLabelText('CPI')).toBeInTheDocument();
    expect(screen.getByLabelText('パープル保持時間')).toBeInTheDocument();
    // スクロール系は出ない。
    expect(screen.queryByLabelText('縦スクロール反転')).toBeNull();

    fireEvent.click(screen.getByText('マウスレイヤー (L4) を開く'));
    expect(onEditMouseLayer).toHaveBeenCalled();
  });

  it('left ball: shows scroll settings and no mouse-layer shortcut', () => {
    render(<TrackballDock side="left" onClose={() => {}} />);

    expect(screen.getByText('左トラックボール')).toBeInTheDocument();
    expect(screen.getByLabelText('スクロール間隔')).toBeInTheDocument();
    expect(screen.getByLabelText('横スクロール反転')).toBeInTheDocument();
    expect(screen.getByLabelText('縦スクロール反転')).toBeInTheDocument();
    expect(screen.queryByLabelText('CPI')).toBeNull();
    expect(screen.queryByText('マウスレイヤー (L4) を開く')).toBeNull();
  });

  it('slider edits land in the settings store', () => {
    render(<TrackballDock side="right" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('CPI'), { target: { value: '1800' } });
    expect(useKobuSettingsStore.getState().local.trackball_cpi).toBe(1800);
  });

  it('toggle edits land in the settings store', async () => {
    render(<TrackballDock side="left" onClose={() => {}} />);
    await userEvent.click(screen.getByLabelText('縦スクロール反転'));
    expect(useKobuSettingsStore.getState().local.scroll_invert_y).toBe(1);
  });

  it('category reset restores defaults for just this ball', () => {
    useKobuSettingsStore.setState({
      local: { ...defaults(), trackball_cpi: 2600, scroll_invert_y: 1 },
    });
    render(<TrackballDock side="right" onClose={() => {}} />);
    fireEvent.click(screen.getByText('このカテゴリを初期化'));
    const local = useKobuSettingsStore.getState().local;
    expect(local.trackball_cpi).toBe(1000);
    // 左ボール（スクロール）系は触らない。
    expect(local.scroll_invert_y).toBe(1);
  });

  it('close button fires onClose', async () => {
    const onClose = vi.fn();
    render(<TrackballDock side="left" onClose={onClose} />);
    await userEvent.click(screen.getByLabelText('トラックボール設定を閉じる'));
    expect(onClose).toHaveBeenCalled();
  });
});
