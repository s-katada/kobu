import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallError } from './filesystem';
import { fetchUf2, flashUf2IntoDirectory, rewriteForDevProxy } from './install';

describe('fetchUf2', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the body as a Uint8Array on 2xx', async () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => buf,
      })),
    );
    const bytes = await fetchUf2('https://example.com/firmware.uf2');
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('streams via body.getReader() and reports incremental progress', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    let i = 0;
    const reader = {
      read: vi.fn(async () => {
        const chunk = chunks[i++];
        return chunk ? { done: false, value: chunk } : { done: true, value: undefined };
      }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '5' }),
        body: { getReader: () => reader },
      })),
    );

    const progress: Array<[number, number | null]> = [];
    const bytes = await fetchUf2('https://example.com/firmware.uf2', (loaded, total) => {
      progress.push([loaded, total]);
    });
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
    // First tick = (0, 5) so the bar appears immediately.
    expect(progress[0]).toEqual([0, 5]);
    expect(progress[progress.length - 1]).toEqual([5, 5]);
  });

  it('reports total=null when Content-Length is missing', async () => {
    const chunks = [new Uint8Array([1, 2, 3])];
    let i = 0;
    const reader = {
      read: vi.fn(async () => {
        const chunk = chunks[i++];
        return chunk ? { done: false, value: chunk } : { done: true, value: undefined };
      }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: { getReader: () => reader },
      })),
    );

    const progress: Array<[number, number | null]> = [];
    await fetchUf2('https://example.com/firmware.uf2', (loaded, total) => {
      progress.push([loaded, total]);
    });
    expect(progress[0]).toEqual([0, null]);
    expect(progress[progress.length - 1]).toEqual([3, null]);
  });

  it('wraps a non-2xx response as InstallError(write-failed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    const err = await fetchUf2('https://example.com/firmware.uf2').catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).kind).toBe('write-failed');
    expect((err as InstallError).message).toContain('404');
  });

  it('wraps a fetch rejection as InstallError(write-failed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    const err = await fetchUf2('https://example.com/firmware.uf2').catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).message).toContain('network down');
  });
});

describe('rewriteForDevProxy', () => {
  it('rewrites github.com URLs to /__release in dev mode', () => {
    // import.meta.env.DEV is true under vitest by default.
    expect(rewriteForDevProxy('https://github.com/foo/bar/releases/download/x/central.uf2')).toBe(
      '/__release/foo/bar/releases/download/x/central.uf2',
    );
  });

  it('leaves non-github URLs untouched', () => {
    expect(rewriteForDevProxy('https://example.com/firmware.uf2')).toBe(
      'https://example.com/firmware.uf2',
    );
  });

  it('preserves query string when rewriting', () => {
    expect(rewriteForDevProxy('https://github.com/a/b?x=1')).toBe('/__release/a/b?x=1');
  });
});

describe('flashUf2IntoDirectory', () => {
  it('delegates to writeUf2 with the same args', async () => {
    // Use a real fake directory that records the call.
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const handle = { createWritable: vi.fn(async () => writable) };
    const dir = {
      getFileHandle: vi.fn(async () => handle),
    } as unknown as FileSystemDirectoryHandle;

    await flashUf2IntoDirectory(dir, 'central.uf2', new Uint8Array([5, 6]));
    expect(dir.getFileHandle).toHaveBeenCalledWith('central.uf2', { create: true });
    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });
});
