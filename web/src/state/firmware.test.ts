import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The firmware module keeps a module-scoped `cached` variable for the
 * page lifetime. To get deterministic tests we reset modules between
 * cases and dynamically import a fresh copy each time.
 */
async function freshModule() {
  vi.resetModules();
  return await import('./firmware');
}

interface AssetFixture {
  name: string;
  size?: number;
  url?: string;
}

interface ReleaseFixture {
  tag: string;
  name?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  publishedAt?: string;
  body?: string | null;
  assets?: AssetFixture[];
}

function buildReleasePayload(fixtures: ReleaseFixture[]): unknown[] {
  return fixtures.map((r) => ({
    tag_name: r.tag,
    name: r.name === undefined ? r.tag : r.name,
    prerelease: r.prerelease ?? false,
    draft: r.draft ?? false,
    published_at: r.publishedAt ?? '2026-05-20T00:00:00Z',
    html_url: `https://github.com/s-katada/kobu/releases/tag/${r.tag}`,
    body: r.body === undefined ? '' : r.body,
    assets: (r.assets ?? []).map((a) => ({
      name: a.name,
      size: a.size ?? 1024,
      browser_download_url:
        a.url ?? `https://github.com/s-katada/kobu/releases/download/${r.tag}/${a.name}`,
    })),
  }));
}

function mockFetchOk(payload: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  });
}

function mockFetchError(status: number, statusText: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    json: async () => ({}),
  });
}

describe('formatBytes', () => {
  it('formats bytes / KB / MB at sensible breakpoints', async () => {
    const { formatBytes } = await freshModule();
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 100)).toBe('100.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.00 MB');
  });
});

describe('findAsset', () => {
  it('returns the asset matched by name', async () => {
    const { findAsset } = await freshModule();
    const release = {
      tag: 'x',
      name: 'x',
      isLatest: false,
      isPrerelease: false,
      publishedAt: '',
      htmlUrl: '',
      body: '',
      assets: [
        { name: 'central.uf2', size: 100, downloadUrl: 'a' },
        { name: 'peripheral.uf2', size: 200, downloadUrl: 'b' },
      ],
    };
    expect(findAsset(release, 'central.uf2')?.size).toBe(100);
    expect(findAsset(release, 'peripheral.uf2')?.size).toBe(200);
  });

  it('returns undefined when the asset is missing', async () => {
    const { findAsset } = await freshModule();
    expect(
      findAsset(
        {
          tag: 'x',
          name: 'x',
          isLatest: false,
          isPrerelease: false,
          publishedAt: '',
          htmlUrl: '',
          body: '',
          assets: [],
        },
        'central.uf2',
      ),
    ).toBeUndefined();
  });
});

describe('useFirmwareReleases', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transitions loading → ready and exposes firmware-* releases sorted with latest first', async () => {
    const payload = buildReleasePayload([
      { tag: 'thumb-pcb-v1.0', name: 'pcb release' }, // should be filtered out
      {
        tag: 'firmware-v1.0',
        publishedAt: '2026-04-01T00:00:00Z',
        assets: [{ name: 'central.uf2' }, { name: 'peripheral.uf2' }],
      },
      {
        tag: 'firmware-latest',
        prerelease: true,
        publishedAt: '2026-05-20T01:00:00Z',
        assets: [{ name: 'central.uf2' }, { name: 'peripheral.uf2' }],
      },
      {
        tag: 'firmware-v0.9',
        publishedAt: '2026-01-01T00:00:00Z',
        assets: [{ name: 'central.uf2' }],
      },
    ]);
    vi.stubGlobal('fetch', mockFetchOk(payload));

    const { useFirmwareReleases } = await freshModule();
    const { result } = renderHook(() => useFirmwareReleases());
    expect(result.current.state.kind).toBe('loading');

    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind !== 'ready') throw new Error('expected ready');
    const tags = result.current.state.releases.map((r) => r.tag);
    expect(tags).toEqual(['firmware-latest', 'firmware-v1.0', 'firmware-v0.9']);
    expect(result.current.state.releases[0]?.isLatest).toBe(true);
  });

  it('drops draft releases', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        buildReleasePayload([{ tag: 'firmware-draft', draft: true }, { tag: 'firmware-real' }]),
      ),
    );
    const { useFirmwareReleases } = await freshModule();
    const { result } = renderHook(() => useFirmwareReleases());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind !== 'ready') throw new Error('expected ready');
    expect(result.current.state.releases.map((r) => r.tag)).toEqual(['firmware-real']);
  });

  it('surfaces a 403 rate-limit error with a helpful hint', async () => {
    vi.stubGlobal('fetch', mockFetchError(403, 'rate limit exceeded'));
    const { useFirmwareReleases } = await freshModule();
    const { result } = renderHook(() => useFirmwareReleases());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind !== 'error') throw new Error('expected error');
    expect(result.current.state.message).toContain('403');
    expect(result.current.state.message).toContain('rate-limited');
  });

  it('surfaces a generic network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    const { useFirmwareReleases } = await freshModule();
    const { result } = renderHook(() => useFirmwareReleases());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind !== 'error') throw new Error('expected error');
    expect(result.current.state.message).toMatch(/failed to fetch/i);
  });

  it('reuses the module-level cache across hook mounts and forces a refetch via refresh()', async () => {
    const fetchMock = mockFetchOk(
      buildReleasePayload([{ tag: 'firmware-latest', prerelease: true }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { useFirmwareReleases } = await freshModule();
    const first = renderHook(() => useFirmwareReleases());
    await waitFor(() => expect(first.result.current.state.kind).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second mount in the same page lifetime should reuse the cache.
    const second = renderHook(() => useFirmwareReleases());
    expect(second.result.current.state.kind).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // refresh() resets the cache and triggers a new fetch.
    second.result.current.refresh();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('normalises release.name when GitHub returns null', async () => {
    const payload = buildReleasePayload([{ tag: 'firmware-latest', name: null, body: null }]);
    vi.stubGlobal('fetch', mockFetchOk(payload));
    const { useFirmwareReleases } = await freshModule();
    const { result } = renderHook(() => useFirmwareReleases());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind !== 'ready') throw new Error('expected ready');
    expect(result.current.state.releases[0]?.name).toBe('firmware-latest');
    expect(result.current.state.releases[0]?.body).toBe('');
  });
});
