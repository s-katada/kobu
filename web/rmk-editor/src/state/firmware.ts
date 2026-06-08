/**
 * Hook + types for fetching kobu firmware releases from GitHub.
 *
 * Reads `https://api.github.com/repos/s-katada/kobu/releases` (public,
 * unauthenticated, rate-limited to 60 req/hour/IP — plenty for a
 * casual user) and exposes a normalised view of just the firmware
 * builds. We surface:
 *
 *   * `latest`         the rolling pre-release tagged `firmware-latest`
 *                      (recreated on every successful main build by
 *                      `.github/workflows/firmware.yml`)
 *   * `tagged`         any release whose tag starts with `firmware-`
 *                      (excluding the moving `firmware-latest` tag)
 *
 * Results are cached in module-scope memory for the page lifetime
 * because the most a casual user expects is "I clicked refresh, it
 * fetched again." Anything more elaborate (localStorage TTLs, etc.) is
 * unnecessary overhead until the page actually starts hitting limits.
 */

import { useCallback, useEffect, useState } from 'react';

const GITHUB_OWNER = 's-katada';
const GITHUB_REPO = 'kobu';
const LATEST_TAG = 'firmware-latest';

export interface FirmwareAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

export interface FirmwareRelease {
  tag: string;
  name: string;
  /** True for the rolling `firmware-latest` pre-release. */
  isLatest: boolean;
  /** True for any release with the `prerelease` flag. */
  isPrerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  body: string;
  assets: FirmwareAsset[];
}

interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  html_url: string;
  body: string | null;
  assets: GithubAsset[];
}

let cached: FirmwareRelease[] | null = null;

function normalise(release: GithubRelease): FirmwareRelease {
  return {
    tag: release.tag_name,
    name: release.name ?? release.tag_name,
    isLatest: release.tag_name === LATEST_TAG,
    isPrerelease: release.prerelease,
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
    body: release.body ?? '',
    assets: release.assets.map((a) => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
    })),
  };
}

/**
 * Fetch firmware releases from GitHub. The list is filtered to entries
 * whose tag starts with `firmware-` so that PCB / case releases
 * (`thumb-pcb-v1.0`, etc.) don't appear here.
 */
async function fetchFirmwareReleases(): Promise<FirmwareRelease[]> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub API ${res.status}: ${res.statusText}${
        res.status === 403 ? ' (rate-limited — try again in an hour)' : ''
      }`,
    );
  }
  const data = (await res.json()) as GithubRelease[];
  return data
    .filter((r) => !r.draft)
    .filter((r) => r.tag_name.startsWith('firmware-'))
    .map(normalise)
    .sort((a, b) => {
      // `firmware-latest` always first; otherwise newest first.
      if (a.isLatest) return -1;
      if (b.isLatest) return 1;
      return b.publishedAt.localeCompare(a.publishedAt);
    });
}

export type FirmwareReleasesState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; releases: FirmwareRelease[] };

export interface UseFirmwareReleases {
  state: FirmwareReleasesState;
  refresh: () => void;
}

export function useFirmwareReleases(): UseFirmwareReleases {
  const [state, setState] = useState<FirmwareReleasesState>(() =>
    cached !== null ? { kind: 'ready', releases: cached } : { kind: 'loading' },
  );

  const load = useCallback(async (force: boolean) => {
    if (!force && cached !== null) {
      setState({ kind: 'ready', releases: cached });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const releases = await fetchFirmwareReleases();
      cached = releases;
      setState({ kind: 'ready', releases });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    if (cached === null) {
      void load(false);
    }
  }, [load]);

  return {
    state,
    refresh: () => {
      cached = null;
      void load(true);
    },
  };
}

/** Find an asset by name (e.g. "kobu-rmk-central.uf2"). */
export function findAsset(release: FirmwareRelease, name: string): FirmwareAsset | undefined {
  return release.assets.find((a) => a.name === name);
}

/** Human-readable file size — KB / MB up to 999. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
