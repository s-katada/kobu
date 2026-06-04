import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearXiaoBootHandle,
  isHandleAccessible,
  isIdbAvailable,
  loadXiaoBootHandle,
  queryHandlePermission,
  requestHandlePermission,
  saveXiaoBootHandle,
} from './handleStore';

interface FakeHandle extends Partial<FileSystemDirectoryHandle> {
  name: string;
  __permissionState?: 'granted' | 'prompt' | 'denied';
  __accessible?: boolean;
}

function fakeHandle(opts: Partial<FakeHandle> = {}): FileSystemDirectoryHandle {
  const state: FakeHandle = {
    name: opts.name ?? 'XIAO-BOOT',
    __permissionState: opts.__permissionState ?? 'granted',
    __accessible: opts.__accessible ?? true,
  };
  const h = {
    ...state,
    queryPermission: vi.fn(async () => state.__permissionState ?? 'denied'),
    requestPermission: vi.fn(async () => state.__permissionState ?? 'denied'),
    getFileHandle: vi.fn(async (name: string) => {
      if (name === 'INFO_UF2.TXT' && state.__accessible) {
        return {} as FileSystemFileHandle;
      }
      throw new DOMException('not found', 'NotFoundError');
    }),
  };
  return h as unknown as FileSystemDirectoryHandle;
}

beforeEach(async () => {
  // Ensure each test starts with an empty IDB. The fake-indexeddb
  // shim resets between Vitest workers but not between tests in the
  // same file.
  await clearXiaoBootHandle();
});

describe('isIdbAvailable', () => {
  it('reports true when fake-indexeddb is loaded', () => {
    expect(isIdbAvailable()).toBe(true);
  });
});

describe('save / load / clear', () => {
  // The real FileSystemDirectoryHandle is a host-defined object that
  // IDB knows how to structured-clone. Our test fake replaces it with
  // a plain serialisable record — vi.fn() methods are NOT cloneable,
  // so this group uses POJOs and skips the permission helpers.
  function persistableHandle(name: string): FileSystemDirectoryHandle {
    return { name } as unknown as FileSystemDirectoryHandle;
  }

  it('returns null when nothing is stored', async () => {
    expect(await loadXiaoBootHandle()).toBeNull();
  });

  it('saves a handle and loads it back', async () => {
    await saveXiaoBootHandle(persistableHandle('XIAO-BOOT'));
    const loaded = await loadXiaoBootHandle();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as { name: string }).name).toBe('XIAO-BOOT');
  });

  it('overwrites an existing handle on re-save', async () => {
    await saveXiaoBootHandle(persistableHandle('OLD'));
    await saveXiaoBootHandle(persistableHandle('NEW'));
    const loaded = await loadXiaoBootHandle();
    expect((loaded as unknown as { name: string }).name).toBe('NEW');
  });

  it('clears the saved handle', async () => {
    await saveXiaoBootHandle(persistableHandle('XIAO-BOOT'));
    await clearXiaoBootHandle();
    expect(await loadXiaoBootHandle()).toBeNull();
  });
});

describe('queryHandlePermission', () => {
  it("returns the handle's reported permission state", async () => {
    expect(await queryHandlePermission(fakeHandle({ __permissionState: 'granted' }))).toBe(
      'granted',
    );
    expect(await queryHandlePermission(fakeHandle({ __permissionState: 'prompt' }))).toBe('prompt');
    expect(await queryHandlePermission(fakeHandle({ __permissionState: 'denied' }))).toBe('denied');
  });

  it('returns "denied" when the handle does not expose queryPermission', async () => {
    const handle = { name: 'no-perm-api' } as unknown as FileSystemDirectoryHandle;
    expect(await queryHandlePermission(handle)).toBe('denied');
  });

  it('returns "denied" when queryPermission throws', async () => {
    const handle = {
      name: 'broken',
      queryPermission: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as FileSystemDirectoryHandle;
    expect(await queryHandlePermission(handle)).toBe('denied');
  });
});

describe('requestHandlePermission', () => {
  it('prompts the handle and returns the result', async () => {
    const handle = fakeHandle({ __permissionState: 'granted' });
    expect(await requestHandlePermission(handle)).toBe('granted');
  });
});

describe('isHandleAccessible', () => {
  it('returns true when INFO_UF2.TXT exists', async () => {
    expect(await isHandleAccessible(fakeHandle({ __accessible: true }))).toBe(true);
  });

  it('returns false when the volume is unmounted (NotFoundError)', async () => {
    expect(await isHandleAccessible(fakeHandle({ __accessible: false }))).toBe(false);
  });
});
