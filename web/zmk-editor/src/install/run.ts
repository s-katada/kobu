/**
 * End-to-end install runner: resolve the XIAO-BOOT directory (reusing a
 * saved handle when possible), download the UF2, and flash it. Shared by
 * the manual firmware section and the build-time "auto build → flash"
 * flow.
 */

import { InstallError, pickXiaoBoot, verifyXiaoBootDirectory } from './filesystem';
import {
  isHandleAccessible,
  loadXiaoBootHandle,
  queryHandlePermission,
  requestHandlePermission,
  saveXiaoBootHandle,
} from './handleStore';
import { fetchUf2, flashUf2IntoDirectory } from './install';

/**
 * Return a writable XIAO-BOOT directory handle. Tries the previously
 * saved handle (silent re-grant when permission is still granted),
 * otherwise prompts the picker. Must be called from a user gesture.
 */
export async function resolveXiaoBootDirectory(): Promise<FileSystemDirectoryHandle> {
  const saved = await loadXiaoBootHandle();
  if (saved) {
    let perm = await queryHandlePermission(saved);
    if (perm === 'prompt') perm = await requestHandlePermission(saved);
    if (perm === 'granted' && (await isHandleAccessible(saved))) return saved;
  }
  const dir = await pickXiaoBoot();
  await saveXiaoBootHandle(dir);
  return dir;
}

export interface InstallProgress {
  step: 'picking' | 'verifying' | 'downloading' | 'writing' | 'done';
  loaded?: number;
  total?: number | null;
}

export interface InstallResult {
  /** Whether the picked directory looked like an Adafruit UF2 volume. */
  verified: boolean;
}

export async function runInstall(
  downloadUrl: string,
  asset: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<InstallResult> {
  onProgress?.({ step: 'picking' });
  const dir = await resolveXiaoBootDirectory();

  onProgress?.({ step: 'verifying' });
  const info = await verifyXiaoBootDirectory(dir);

  onProgress?.({ step: 'downloading', loaded: 0, total: null });
  const bytes = await fetchUf2(downloadUrl, (loaded, total) =>
    onProgress?.({ step: 'downloading', loaded, total }),
  );

  onProgress?.({ step: 'writing' });
  await flashUf2IntoDirectory(dir, asset, bytes);

  onProgress?.({ step: 'done' });
  return { verified: info !== null };
}

/**
 * Flash UF2 bytes we already hold in memory (e.g. extracted from a build
 * artifact) rather than fetching from a URL.
 */
export async function flashBytes(
  bytes: Uint8Array,
  asset: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<InstallResult> {
  onProgress?.({ step: 'picking' });
  const dir = await resolveXiaoBootDirectory();
  onProgress?.({ step: 'verifying' });
  const info = await verifyXiaoBootDirectory(dir);
  onProgress?.({ step: 'writing' });
  await flashUf2IntoDirectory(dir, asset, bytes);
  onProgress?.({ step: 'done' });
  return { verified: info !== null };
}

export { InstallError };
