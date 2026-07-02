import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The firmware module is cached at module scope, so reload the
 * component (and every transitive module behind it) between tests.
 */
async function freshFirmwareSection() {
  vi.resetModules();
  const componentMod = await import('./FirmwareSection');
  return { FirmwareSection: componentMod.FirmwareSection };
}

function mockFetchOk(payload: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  });
}

function fixtureLatestRelease() {
  return [
    {
      tag_name: 'firmware-latest',
      name: 'Latest firmware build (abc1234)',
      prerelease: true,
      draft: false,
      published_at: '2026-05-20T01:00:00Z',
      html_url: 'https://github.com/s-katada/kobu/releases/tag/firmware-latest',
      body: 'Released notes content.',
      assets: [
        {
          name: 'kobu-rmk-central.uf2',
          size: 902656,
          browser_download_url:
            'https://github.com/s-katada/kobu/releases/download/firmware-latest/kobu-rmk-central.uf2',
        },
        {
          name: 'kobu-rmk-peripheral.uf2',
          size: 581632,
          browser_download_url:
            'https://github.com/s-katada/kobu/releases/download/firmware-latest/kobu-rmk-peripheral.uf2',
        },
      ],
    },
  ];
}

describe('FirmwareSection', () => {
  // Save and restore showDirectoryPicker so the embedded InstallButton
  // renders its supported branch (with the install button) in jsdom.
  let originalShowDirectoryPicker:
    | ((opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>)
    | undefined;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    const w = window as Window & {
      showDirectoryPicker?: (opts?: {
        mode?: 'read' | 'readwrite';
      }) => Promise<FileSystemDirectoryHandle>;
    };
    originalShowDirectoryPicker = w.showDirectoryPicker;
    w.showDirectoryPicker = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    const w = window as unknown as {
      showDirectoryPicker:
        | ((opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>)
        | undefined;
    };
    w.showDirectoryPicker = originalShowDirectoryPicker;
  });

  it('shows the loading state immediately and the release card once the fetch resolves', async () => {
    vi.stubGlobal('fetch', mockFetchOk(fixtureLatestRelease()));
    const { FirmwareSection } = await freshFirmwareSection();
    render(<FirmwareSection />);

    expect(screen.getByText('リリース情報を取得中…')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText('Latest firmware build (abc1234)')).toBeInTheDocument(),
    );
    expect(screen.getByText('latest')).toBeInTheDocument();

    // Download fallback links carry the correct href + download attrs.
    const centralLink = screen.getByRole('link', { name: /kobu-rmk-central\.uf2/ });
    expect(centralLink).toHaveAttribute(
      'href',
      'https://github.com/s-katada/kobu/releases/download/firmware-latest/kobu-rmk-central.uf2',
    );
    expect(centralLink).toHaveAttribute('download', 'kobu-rmk-central.uf2');
    const peripheralLink = screen.getByRole('link', { name: /kobu-rmk-peripheral\.uf2/ });
    expect(peripheralLink).toHaveAttribute(
      'href',
      'https://github.com/s-katada/kobu/releases/download/firmware-latest/kobu-rmk-peripheral.uf2',
    );
  });

  it('renders one install button per side', async () => {
    vi.stubGlobal('fetch', mockFetchOk(fixtureLatestRelease()));
    const { FirmwareSection } = await freshFirmwareSection();
    render(<FirmwareSection />);
    await waitFor(() =>
      expect(screen.getByText('Latest firmware build (abc1234)')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /セントラル.*をインストール/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ペリフェラル.*をインストール/ }),
    ).toBeInTheDocument();
  });

  it('renders the empty state when no firmware releases exist', async () => {
    vi.stubGlobal('fetch', mockFetchOk([]));
    const { FirmwareSection } = await freshFirmwareSection();
    render(<FirmwareSection />);
    await waitFor(() =>
      expect(
        screen.getByText(/公開済みのファームウェアビルドがまだありません/),
      ).toBeInTheDocument(),
    );
  });

  it('renders an error state when the API returns 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 403, statusText: 'limit', json: async () => ({}) }),
    );
    const { FirmwareSection } = await freshFirmwareSection();
    render(<FirmwareSection />);
    await waitFor(() =>
      expect(screen.getByText(/リリース情報の取得に失敗しました/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/rate-limited/)).toBeInTheDocument();
  });

  it('clicking 再取得 forces a refetch (cache reset)', async () => {
    const fetchMock = mockFetchOk(fixtureLatestRelease());
    vi.stubGlobal('fetch', fetchMock);
    const { FirmwareSection } = await freshFirmwareSection();
    render(<FirmwareSection />);
    await waitFor(() =>
      expect(screen.getByText('Latest firmware build (abc1234)')).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: '再取得' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
