/**
 * Glue between a GitHub release asset and the File System Access API.
 *
 * `fetchUf2()` pulls the `.uf2` blob over HTTPS into a `Uint8Array` so
 * we can hand it to the filesystem writer. The browser caches the
 * download via the standard HTTP cache; no extra state needed.
 *
 * The actual install is driven by the `InstallButton` component — this
 * module deliberately stays a thin function library so unit tests can
 * exercise each step in isolation.
 */

import { InstallError, verifyXiaoBootDirectory, writeUf2 } from './filesystem';

/**
 * GitHub Release downloads from `github.com` don't return CORS
 * headers, so a direct `fetch()` from the browser fails. Both the
 * dev server (`vite.config.ts`) and the production Worker
 * (`worker/index.ts`) proxy `/__release/*` to `https://github.com/*`,
 * making the request same-origin from the browser's point of view.
 * Rewrite the asset URL accordingly whenever we're running in a
 * browser context.
 */
export function rewriteForSameOriginProxy(downloadUrl: string): string {
  if (typeof window === 'undefined') return downloadUrl;
  const url = new URL(downloadUrl);
  if (url.host !== 'github.com') return downloadUrl;
  return `/__release${url.pathname}${url.search}`;
}

/**
 * Reports streaming download progress.
 *
 * `total` is `null` when the server didn't send Content-Length (e.g.
 * the response is chunked through the dev proxy). The UI shows a
 * by-bytes counter without a percentage in that case.
 */
export type FetchProgress = (loaded: number, total: number | null) => void;

/**
 * Fetch a UF2 release asset and return its bytes. Streams the body
 * via `response.body.getReader()` so the UI can render a progress
 * bar: `onProgress(loaded, total)` is called after every chunk.
 *
 * Rejects with `InstallError('write-failed', ...)` when the HTTP
 * response is not 2xx — using the same error kind keeps the UI
 * layer's switch statement small.
 */
export async function fetchUf2(
  downloadUrl: string,
  onProgress?: FetchProgress,
): Promise<Uint8Array> {
  const url = rewriteForSameOriginProxy(downloadUrl);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new InstallError(
      'write-failed',
      `uf2 のダウンロードに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new InstallError(
      'write-failed',
      `uf2 のダウンロードに失敗しました: HTTP ${res.status} ${res.statusText}`,
    );
  }

  const contentLengthHeader = res.headers?.get?.('content-length') ?? null;
  const total = contentLengthHeader ? Number(contentLengthHeader) : null;
  // `.body` is null on opaque responses or unusual fetch polyfills; fall
  // back to arrayBuffer in that case so the install still completes
  // (we just lose progress granularity).
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  // Surface an initial 0-of-N tick so the bar appears immediately
  // instead of jumping straight from "0 B" to the first chunk size.
  onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Write `bytes` into `dir` as `filename`, optionally probing for
 * `INFO_UF2.TXT` first. When the probe fails (returns null) the
 * caller is expected to have already shown a "this doesn't look like
 * XIAO-BOOT — continue?" prompt.
 */
export async function flashUf2IntoDirectory(
  dir: FileSystemDirectoryHandle,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  await writeUf2(dir, filename, bytes);
}

export { verifyXiaoBootDirectory };
