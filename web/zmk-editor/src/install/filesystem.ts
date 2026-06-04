/**
 * Thin wrapper around the File System Access API for writing UF2
 * firmware blobs into the XIAO BLE's mass-storage bootloader volume
 * (`XIAO-BOOT`). Ported from the kobu-editor (RMK) app — the flashing
 * mechanism is firmware-agnostic.
 *
 * Flow: gate on Chromium → `pickXiaoBoot()` (user resets the half into
 * bootloader mode first) → `verifyXiaoBootDirectory()` (INFO_UF2.TXT
 * sanity check) → `writeUf2()` (the bootloader flashes + reboots).
 */

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

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function pickXiaoBoot(): Promise<FileSystemDirectoryHandle> {
  const picker = window.showDirectoryPicker;
  if (!picker) {
    throw new InstallError(
      'unsupported',
      'このブラウザは File System Access API に対応していません。Chrome / Edge / Brave / Opera を使用してください。',
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
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
  } catch (err) {
    // Mid-write disconnect: the bootloader consumed enough to flash and
    // is rebooting. Treat as success.
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
  return (
    err.name === 'InvalidStateError' || err.name === 'NotFoundError' || err.name === 'NetworkError'
  );
}

function isPostWriteCheckFailure(err: unknown): boolean {
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : '';
  if (/safe browsing/i.test(message)) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return false;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
