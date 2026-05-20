import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InstallError,
  isFileSystemAccessSupported,
  pickXiaoBoot,
  verifyXiaoBootDirectory,
  writeUf2,
} from './filesystem';

interface FakeWritable {
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface FakeFileHandle {
  getFile: ReturnType<typeof vi.fn>;
  createWritable: ReturnType<typeof vi.fn>;
}

function makeFile(text: string): { getFile: () => Promise<{ text: () => Promise<string> }> } {
  return { getFile: async () => ({ text: async () => text }) };
}

function makeWritable(opts: { writeError?: unknown; closeError?: unknown } = {}): FakeWritable {
  return {
    write: vi.fn(async () => {
      if (opts.writeError) throw opts.writeError;
    }),
    close: vi.fn(async () => {
      if (opts.closeError) throw opts.closeError;
    }),
  };
}

function makeDirectory(opts: {
  infoFile?: { text: string } | 'missing';
  fileHandle?: FakeFileHandle;
  getFileError?: unknown;
}): FileSystemDirectoryHandle {
  const dir = {
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (name === 'INFO_UF2.TXT' && !options?.create) {
        if (opts.infoFile === 'missing' || !opts.infoFile) {
          const e = new DOMException('not found', 'NotFoundError');
          throw e;
        }
        return makeFile(opts.infoFile.text);
      }
      if (opts.getFileError) throw opts.getFileError;
      return opts.fileHandle ?? makeFileHandle();
    }),
  } as unknown as FileSystemDirectoryHandle;
  return dir;
}

function makeFileHandle(writable?: FakeWritable): FakeFileHandle {
  return {
    getFile: vi.fn(),
    createWritable: vi.fn(async () => writable ?? makeWritable()),
  };
}

describe('isFileSystemAccessSupported', () => {
  it('returns true when showDirectoryPicker exists on window', () => {
    vi.stubGlobal('window', { showDirectoryPicker: () => undefined });
    expect(isFileSystemAccessSupported()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('returns false when showDirectoryPicker is missing', () => {
    vi.stubGlobal('window', {});
    expect(isFileSystemAccessSupported()).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('pickXiaoBoot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the directory handle the picker resolves with', async () => {
    const handle = {} as FileSystemDirectoryHandle;
    vi.stubGlobal('window', {
      showDirectoryPicker: vi.fn(async () => handle),
    });
    await expect(pickXiaoBoot()).resolves.toBe(handle);
  });

  it('throws InstallError(unsupported) when API is missing', async () => {
    vi.stubGlobal('window', {});
    await expect(pickXiaoBoot()).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('maps AbortError → picker-cancelled', async () => {
    vi.stubGlobal('window', {
      showDirectoryPicker: vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    });
    await expect(pickXiaoBoot()).rejects.toMatchObject({ kind: 'picker-cancelled' });
  });

  it('maps NotAllowedError → permission-denied', async () => {
    vi.stubGlobal('window', {
      showDirectoryPicker: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    });
    await expect(pickXiaoBoot()).rejects.toMatchObject({ kind: 'permission-denied' });
  });

  it('rethrows unknown errors untouched', async () => {
    vi.stubGlobal('window', {
      showDirectoryPicker: vi.fn(async () => {
        throw new TypeError('something weird');
      }),
    });
    await expect(pickXiaoBoot()).rejects.toThrow(TypeError);
  });
});

describe('verifyXiaoBootDirectory', () => {
  it('returns the INFO_UF2.TXT content when present', async () => {
    const dir = makeDirectory({ infoFile: { text: 'UF2 Bootloader v1.2.3\nModel: XIAO BLE' } });
    const result = await verifyXiaoBootDirectory(dir);
    expect(result).toContain('UF2 Bootloader');
  });

  it('returns null when INFO_UF2.TXT is missing', async () => {
    const dir = makeDirectory({ infoFile: 'missing' });
    const result = await verifyXiaoBootDirectory(dir);
    expect(result).toBeNull();
  });

  it('rethrows non-NotFoundError DOMExceptions', async () => {
    const dir = {
      getFileHandle: vi.fn(async () => {
        throw new DOMException('bad', 'SecurityError');
      }),
    } as unknown as FileSystemDirectoryHandle;
    await expect(verifyXiaoBootDirectory(dir)).rejects.toThrow(DOMException);
  });
});

describe('writeUf2', () => {
  let baseDir: FileSystemDirectoryHandle;
  let writable: FakeWritable;

  beforeEach(() => {
    writable = makeWritable();
    const handle = makeFileHandle(writable);
    baseDir = {
      getFileHandle: vi.fn(async () => handle),
    } as unknown as FileSystemDirectoryHandle;
  });

  it('writes and closes the file', async () => {
    await writeUf2(baseDir, 'central.uf2', new Uint8Array([1, 2, 3]));
    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('swallows InvalidStateError during write (device rebooted)', async () => {
    writable = makeWritable({ writeError: new DOMException('gone', 'InvalidStateError') });
    const handle = makeFileHandle(writable);
    baseDir = {
      getFileHandle: vi.fn(async () => handle),
    } as unknown as FileSystemDirectoryHandle;
    await expect(writeUf2(baseDir, 'central.uf2', new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it('swallows NotFoundError during close', async () => {
    writable = makeWritable({ closeError: new DOMException('gone', 'NotFoundError') });
    const handle = makeFileHandle(writable);
    baseDir = {
      getFileHandle: vi.fn(async () => handle),
    } as unknown as FileSystemDirectoryHandle;
    await expect(writeUf2(baseDir, 'central.uf2', new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it('swallows Safe Browsing failures during close (bootloader rebooted mid-scan)', async () => {
    writable = makeWritable({
      closeError: new DOMException('Failed to perform Safe Browsing check.', 'AbortError'),
    });
    const handle = makeFileHandle(writable);
    baseDir = {
      getFileHandle: vi.fn(async () => handle),
    } as unknown as FileSystemDirectoryHandle;
    await expect(writeUf2(baseDir, 'central.uf2', new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it('also swallows close errors that mention Safe Browsing on a non-DOMException', async () => {
    writable = makeWritable({ closeError: new Error('Failed to perform Safe Browsing check.') });
    const handle = makeFileHandle(writable);
    baseDir = {
      getFileHandle: vi.fn(async () => handle),
    } as unknown as FileSystemDirectoryHandle;
    await expect(writeUf2(baseDir, 'central.uf2', new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it('wraps non-disconnect write errors in InstallError(write-failed)', async () => {
    writable = makeWritable({ writeError: new TypeError('boom') });
    const handle = makeFileHandle(writable);
    baseDir = {
      getFileHandle: vi.fn(async () => handle),
    } as unknown as FileSystemDirectoryHandle;
    await expect(writeUf2(baseDir, 'central.uf2', new Uint8Array([1]))).rejects.toMatchObject({
      kind: 'write-failed',
    });
  });

  it('wraps a NotAllowedError on createWritable as permission-denied', async () => {
    const handle: FakeFileHandle = {
      getFile: vi.fn(),
      createWritable: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    };
    baseDir = {
      getFileHandle: vi.fn(async () => handle),
    } as unknown as FileSystemDirectoryHandle;
    await expect(writeUf2(baseDir, 'central.uf2', new Uint8Array([1]))).rejects.toMatchObject({
      kind: 'permission-denied',
    });
  });

  it('wraps getFileHandle failure in InstallError(write-failed)', async () => {
    baseDir = {
      getFileHandle: vi.fn(async () => {
        throw new Error('disk full');
      }),
    } as unknown as FileSystemDirectoryHandle;
    const err = await writeUf2(baseDir, 'central.uf2', new Uint8Array([1])).catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).kind).toBe('write-failed');
  });
});
