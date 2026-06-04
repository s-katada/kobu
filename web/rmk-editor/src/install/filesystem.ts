/**
 * Thin wrapper around the File System Access API for writing UF2
 * firmware blobs into the XIAO BLE's mass-storage bootloader volume.
 *
 * The flow is:
 *
 *   1. `isFileSystemAccessSupported()` — gate the install button on
 *      Chromium browsers that ship the API. Safari / Firefox fall
 *      through to the existing "uf2 をダウンロード" path.
 *   2. `pickXiaoBoot()` — prompt the user with a directory picker. The
 *      user has to physically reset the XIAO into bootloader mode first
 *      so that `XIAO-BOOT` shows up in their OS file manager. We can't
 *      detect mount events from the browser so this step is necessarily
 *      user-driven.
 *   3. `verifyXiaoBootDirectory()` — quick sanity check that the picked
 *      directory looks like an Adafruit UF2 bootloader volume
 *      (presence of `INFO_UF2.TXT`). Returns the parsed info or null
 *      when missing, so callers can warn but still proceed if the user
 *      insists.
 *   4. `writeUf2()` — copy the bytes into the directory as a file. The
 *      bootloader takes care of validating + flashing + rebooting from
 *      there.
 *
 * Error model: every recoverable failure throws an `InstallError` with
 * a stable `kind`. Anything else is unexpected and bubbles up
 * untouched.
 */

// File System Access API types aren't in lib.dom yet — add a narrow
// declaration so we can call it without `any`. Optional because the
// browser may not implement it (Safari / Firefox).
declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export type InstallErrorKind =
  | 'unsupported'
  | 'picker-cancelled'
  | 'permission-denied'
  | 'write-failed';

export class InstallError extends Error {
  readonly kind: InstallErrorKind;
  constructor(kind: InstallErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'InstallError';
  }
}

/**
 * True when the browser implements `window.showDirectoryPicker`.
 * Currently means Chromium-based (Chrome / Edge / Brave / Opera) on
 * desktop or recent Chrome on Android.
 */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * Open a writable directory picker. Throws `InstallError('unsupported')`
 * when the API is missing and `InstallError('picker-cancelled')` when
 * the user closes the picker without selecting anything.
 */
export async function pickXiaoBoot(): Promise<FileSystemDirectoryHandle> {
  if (!isFileSystemAccessSupported()) {
    throw new InstallError(
      'unsupported',
      'このブラウザは File System Access API に対応していません。Chrome / Edge / Brave / Opera を使用してください。',
    );
  }
  const picker = window.showDirectoryPicker;
  if (!picker) {
    throw new InstallError(
      'unsupported',
      'このブラウザは File System Access API に対応していません。',
    );
  }
  try {
    return await picker({ mode: 'readwrite' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new InstallError('picker-cancelled', 'ディレクトリ選択がキャンセルされました。');
    }
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new InstallError(
        'permission-denied',
        '書き込み権限が拒否されました。次回プロンプトで「許可」を選んでください。',
      );
    }
    throw err;
  }
}

/**
 * Sanity check: read `INFO_UF2.TXT` from the picked directory and
 * return its content. Returns `null` when the file is missing — the
 * user picked something that isn't an Adafruit UF2 bootloader volume.
 * Any other I/O error throws untouched so the caller can surface it.
 */
export async function verifyXiaoBootDirectory(
  dir: FileSystemDirectoryHandle,
): Promise<string | null> {
  try {
    const handle = await dir.getFileHandle('INFO_UF2.TXT', { create: false });
    const file = await handle.getFile();
    return await file.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null;
    throw err;
  }
}

/**
 * Write `bytes` to `filename` inside the picked directory. The
 * Adafruit UF2 bootloader on the XIAO BLE consumes the file
 * synchronously, then reboots and unmounts itself — `close()` may
 * therefore reject mid-write when the device disappears, which we
 * treat as success.
 */
export async function writeUf2(
  dir: FileSystemDirectoryHandle,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  let handle: FileSystemFileHandle;
  try {
    handle = await dir.getFileHandle(filename, { create: true });
  } catch (err) {
    throw new InstallError('write-failed', `ファイルを作成できませんでした: ${describe(err)}`);
  }

  let writable: FileSystemWritableFileStream;
  try {
    writable = await handle.createWritable();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new InstallError(
        'permission-denied',
        '書き込み権限が拒否されました。次回プロンプトで「許可」を選んでください。',
      );
    }
    throw new InstallError(
      'write-failed',
      `書き込みストリームを開けませんでした: ${describe(err)}`,
    );
  }

  try {
    // The DOM types insist on `ArrayBuffer`-backed views, but our
    // bytes already are; cast to the exact view the API expects.
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
  } catch (err) {
    // Mid-write disconnect: bootloader has consumed enough to flash and
    // is rebooting. Treat as success — closing the writable below may
    // also reject for the same reason.
    if (looksLikeDeviceDisappeared(err)) return;
    throw new InstallError('write-failed', `書き込みに失敗しました: ${describe(err)}`);
  }

  try {
    await writable.close();
  } catch (err) {
    if (looksLikeDeviceDisappeared(err)) return;
    if (isPostWriteCheckFailure(err)) return;
    throw new InstallError('write-failed', `書き込みの完了処理に失敗しました: ${describe(err)}`);
  }
}

function looksLikeDeviceDisappeared(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false;
  // After the bootloader consumes the UF2 it reboots and unmounts the
  // volume; the in-flight write / close gets one of these.
  return (
    err.name === 'InvalidStateError' || err.name === 'NotFoundError' || err.name === 'NetworkError'
  );
}

/**
 * After `writable.write(bytes)` returns the bytes are already on disk;
 * `close()` then flushes and runs Chrome's Safe Browsing scan. When the
 * UF2 bootloader consumes the file and reboots mid-scan, the scan can
 * fail with messages like "Failed to perform Safe Browsing check." We
 * treat that as success because the firmware update has actually
 * landed — the close() just couldn't finish its post-write hygiene.
 */
function isPostWriteCheckFailure(err: unknown): boolean {
  // Duck-type rather than `instanceof Error` — jsdom's DOMException is
  // not an Error subclass, and we want to catch it in tests too.
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : '';
  if (/safe browsing/i.test(message)) return true;
  // Chrome also surfaces some quarantine failures as AbortError without
  // a more descriptive message; treat those the same way.
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return false;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
