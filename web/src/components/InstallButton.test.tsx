import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirmwareAsset } from '../state/firmware';
import { InstallButton } from './InstallButton';

const ASSET: FirmwareAsset = {
  name: 'central.uf2',
  size: 902656,
  downloadUrl: 'https://example.com/central.uf2',
};

type WindowWithExtras = Window &
  typeof globalThis & {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
    confirm: (message?: string) => boolean;
  };

const W = window as unknown as WindowWithExtras;

let originalShowDirectoryPicker: WindowWithExtras['showDirectoryPicker'];
let originalConfirm: WindowWithExtras['confirm'];

function setShowDirectoryPicker(
  fn: ((opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>) | null,
) {
  // exactOptionalPropertyTypes forbids assigning `undefined` to an
  // optional-only field, so cast to a `(... | undefined)` slot for the
  // remove path.
  type Setter = {
    showDirectoryPicker:
      | ((opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>)
      | undefined;
  };
  if (fn === null) {
    (W as unknown as Setter).showDirectoryPicker = undefined;
  } else {
    (W as unknown as Setter).showDirectoryPicker = fn;
  }
}

function makeFakeXiaoBoot({ withInfo = true } = {}): {
  handle: FileSystemDirectoryHandle;
  writes: Array<{ name: string; bytes: Uint8Array }>;
} {
  const writes: Array<{ name: string; bytes: Uint8Array }> = [];
  let pendingName = '';
  const writable = {
    write: vi.fn(async (bytes: Uint8Array) => {
      writes.push({ name: pendingName, bytes });
    }),
    close: vi.fn(async () => undefined),
  };
  const infoHandle = {
    getFile: async () => ({ text: async () => 'UF2 Bootloader v1\nModel: XIAO BLE' }),
  };
  const writableHandle = {
    createWritable: vi.fn(async () => writable),
  };
  const handle = {
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (name === 'INFO_UF2.TXT' && !options?.create) {
        if (!withInfo) throw new DOMException('not found', 'NotFoundError');
        return infoHandle;
      }
      pendingName = name;
      return writableHandle;
    }),
  } as unknown as FileSystemDirectoryHandle;
  return { handle, writes };
}

function stubFetchOk(bytes: number[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    })),
  );
}

describe('InstallButton', () => {
  beforeEach(() => {
    originalShowDirectoryPicker = W.showDirectoryPicker;
    originalConfirm = W.confirm;
    // Default: showDirectoryPicker is present.
    setShowDirectoryPicker(vi.fn());
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    setShowDirectoryPicker(originalShowDirectoryPicker ?? null);
    W.confirm = originalConfirm;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders an unsupported fallback when the browser lacks showDirectoryPicker', () => {
    setShowDirectoryPicker(null);
    render(<InstallButton label="セントラル" asset={ASSET} />);
    expect(screen.getByText(/Chrome \/ Edge \/ Brave \/ Opera/)).toBeInTheDocument();
  });

  it('shows the wizard with reset instructions on first click', async () => {
    render(<InstallButton label="セントラル" asset={ASSET} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));
    expect(screen.getByText(/RESET ボタンを素早く 2 回押す/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /XIAO-BOOT を選択/ })).toBeInTheDocument();
  });

  it('completes the happy path: pick → verify → fetch → write → done', async () => {
    const { handle, writes } = makeFakeXiaoBoot({ withInfo: true });
    setShowDirectoryPicker(vi.fn(async () => handle));
    stubFetchOk([0xde, 0xad, 0xbe, 0xef]);

    render(<InstallButton label="セントラル" asset={ASSET} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));
    await userEvent.click(screen.getByRole('button', { name: /XIAO-BOOT を選択/ }));

    await waitFor(() => expect(screen.getByText(/書き込みが完了しました/)).toBeInTheDocument());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.name).toBe('central.uf2');
    expect(Array.from(writes[0]?.bytes ?? [])).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('warns via window.confirm when INFO_UF2.TXT is missing and proceeds if user accepts', async () => {
    const { handle, writes } = makeFakeXiaoBoot({ withInfo: false });
    setShowDirectoryPicker(vi.fn(async () => handle));
    stubFetchOk([1, 2]);
    const confirmSpy = vi.fn(() => true);
    W.confirm = confirmSpy;

    render(<InstallButton label="セントラル" asset={ASSET} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));
    await userEvent.click(screen.getByRole('button', { name: /XIAO-BOOT を選択/ }));

    await waitFor(() => expect(screen.getByText(/書き込みが完了しました/)).toBeInTheDocument());

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
  });

  it('aborts when the user cancels the confirm dialog', async () => {
    const { handle, writes } = makeFakeXiaoBoot({ withInfo: false });
    setShowDirectoryPicker(vi.fn(async () => handle));
    stubFetchOk([1, 2]);
    W.confirm = vi.fn(() => false);

    render(<InstallButton label="セントラル" asset={ASSET} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));
    await userEvent.click(screen.getByRole('button', { name: /XIAO-BOOT を選択/ }));

    // Goes back to the reset step.
    await waitFor(() =>
      expect(screen.getByText(/RESET ボタンを素早く 2 回押す/)).toBeInTheDocument(),
    );
    expect(writes).toHaveLength(0);
  });

  it('returns to the reset step when the picker is cancelled', async () => {
    setShowDirectoryPicker(
      vi.fn(async () => {
        throw new DOMException('abort', 'AbortError');
      }),
    );

    render(<InstallButton label="セントラル" asset={ASSET} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));
    await userEvent.click(screen.getByRole('button', { name: /XIAO-BOOT を選択/ }));

    await waitFor(() =>
      expect(screen.getByText(/RESET ボタンを素早く 2 回押す/)).toBeInTheDocument(),
    );
  });

  it('shows an error and a retry button when the download fails', async () => {
    const { handle } = makeFakeXiaoBoot({ withInfo: true });
    setShowDirectoryPicker(vi.fn(async () => handle));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    render(<InstallButton label="セントラル" asset={ASSET} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));
    await userEvent.click(screen.getByRole('button', { name: /XIAO-BOOT を選択/ }));

    await waitFor(() => expect(screen.getByText(/エラー:/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'やり直す' })).toBeInTheDocument();
  });

  it('cancel button returns from the wizard to the idle button', async () => {
    render(<InstallButton label="セントラル" asset={ASSET} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByRole('button', { name: /セントラルをインストール/ })).toBeInTheDocument();
  });
});
