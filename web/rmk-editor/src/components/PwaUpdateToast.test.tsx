import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PwaUpdateToast } from './PwaUpdateToast';

// Override the global stub from `src/test/setup.ts` per-test so each
// case can pick its own `useRegisterSW` return shape.
vi.mock('virtual:pwa-register/react', async () => ({
  useRegisterSW: vi.fn(() => ({
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(async () => {}),
  })),
}));

import { useRegisterSW } from 'virtual:pwa-register/react';

const mockedUseRegisterSW = useRegisterSW as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  mockedUseRegisterSW.mockReset();
  mockedUseRegisterSW.mockImplementation(() => ({
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(async () => {}),
  }));
});

describe('PwaUpdateToast', () => {
  it('renders nothing when no SW activity is pending', () => {
    const { container } = render(<PwaUpdateToast />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the offline-ready toast when offlineReady is true', () => {
    mockedUseRegisterSW.mockImplementation(() => ({
      needRefresh: [false, vi.fn()],
      offlineReady: [true, vi.fn()],
      updateServiceWorker: vi.fn(async () => {}),
    }));
    render(<PwaUpdateToast />);
    expect(screen.getByText('オフラインで使えます')).toBeTruthy();
  });

  it('shows the update toast when needRefresh is true', async () => {
    const updateFn = vi.fn(async () => {});
    mockedUseRegisterSW.mockImplementation(() => ({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: updateFn,
    }));
    const user = userEvent.setup();
    render(<PwaUpdateToast />);
    expect(screen.getByText('新しいバージョンがあります')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '更新' }));
    expect(updateFn).toHaveBeenCalledWith(true);
  });

  it('"あとで" dismisses the update toast', async () => {
    const setNeedRefresh = vi.fn();
    mockedUseRegisterSW.mockImplementation(() => ({
      needRefresh: [true, setNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(async () => {}),
    }));
    const user = userEvent.setup();
    render(<PwaUpdateToast />);
    await user.click(screen.getByRole('button', { name: 'あとで' }));
    expect(setNeedRefresh).toHaveBeenCalledWith(false);
  });

  it('update toast takes precedence over offline-ready when both fire', () => {
    mockedUseRegisterSW.mockImplementation(() => ({
      needRefresh: [true, vi.fn()],
      offlineReady: [true, vi.fn()],
      updateServiceWorker: vi.fn(async () => {}),
    }));
    render(<PwaUpdateToast />);
    expect(screen.getByText('新しいバージョンがあります')).toBeTruthy();
    expect(screen.queryByText('オフラインで使えます')).toBeNull();
  });
});
