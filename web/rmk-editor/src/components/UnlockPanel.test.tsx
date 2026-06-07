import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUnlockStore } from '../state/unlock';
import { UnlockPanel } from './UnlockPanel';

afterEach(() => {
  useUnlockStore.getState().detach();
});

describe('UnlockPanel', () => {
  it('renders nothing while the lock status is unknown', () => {
    useUnlockStore.setState({ status: 'unknown' });
    const { container } = render(<UnlockPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the locked banner with the chord keys and an unlock button', () => {
    useUnlockStore.setState({
      status: 'locked',
      chord: [
        { row: 0, col: 0 },
        { row: 0, col: 9 },
      ],
      error: null,
    });
    render(<UnlockPanel />);
    expect(screen.getByText(/ロックされています/)).toBeTruthy();
    expect(screen.getByText(/行0列0 ＋ 行0列9/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'アンロック' })).toBeTruthy();
  });

  it('clicking アンロック calls beginUnlock', async () => {
    const beginUnlock = vi.fn();
    useUnlockStore.setState({ status: 'locked', chord: [], beginUnlock });
    render(<UnlockPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'アンロック' }));
    expect(beginUnlock).toHaveBeenCalledOnce();
  });

  it('shows a live countdown while unlocking and a cancel button', async () => {
    const cancel = vi.fn();
    useUnlockStore.setState({ status: 'unlocking', chord: [], remaining: 30, total: 50, cancel });
    render(<UnlockPanel />);
    // "押し続けてください" appears in both the instruction and the countdown,
    // so assert on the countdown's unique remaining-count text.
    expect(screen.getByText(/あと 30/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('shows the unlocked confirmation with a relock button', async () => {
    const relock = vi.fn();
    useUnlockStore.setState({ status: 'unlocked', relock });
    render(<UnlockPanel />);
    expect(screen.getByText(/アンロック済み/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '再ロック' }));
    expect(relock).toHaveBeenCalledOnce();
  });

  it('renders an error as an alert', () => {
    useUnlockStore.setState({
      status: 'locked',
      chord: [],
      error: 'アンロックがタイムアウトしました。',
    });
    render(<UnlockPanel />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/タイムアウト/);
  });
});
