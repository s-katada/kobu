/**
 * Glue between a GitHub release asset and the File System Access API.
 * Ported from kobu-editor.
 */

import { InstallError, verifyXiaoBootDirectory, writeUf2 } from './filesystem';

/**
 * GitHub Release downloads don't return CORS headers, so a direct
 * `fetch()` from the browser fails. The dev server (`vite.config.ts`)
 * and the production Worker (web/worker/index.ts) proxy `/__release/*`
 * to `https://github.com/*`, making the request same-origin.
 */
export function rewriteForSameOriginProxy(downloadUrl: string): string {
  if (typeof window === 'undefined') return downloadUrl;
  const url = new URL(downloadUrl);
  if (url.host !== 'github.com') return downloadUrl;
  return `/__release${url.pathname}${url.search}`;
}

export type FetchProgress = (loaded: number, total: number | null) => void;

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
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
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

export async function flashUf2IntoDirectory(
  dir: FileSystemDirectoryHandle,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  await writeUf2(dir, filename, bytes);
}

export { verifyXiaoBootDirectory };
