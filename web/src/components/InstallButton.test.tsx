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

/**
 * `mode='clean'` is a two-stage flash: reset uf2 first (clears storage
 * on boot), then normal uf2 (so further customisations persist). No
 * Vial connection needed.
 */
describe('InstallButton (clean mode)', () => {
  const RESET_ASSET: FirmwareAsset = {
    name: 'central-reset.uf2',
    size: 902656,
    downloadUrl: 'https://example.com/central-reset.uf2',
  };

  beforeEach(() => {
    originalShowDirectoryPicker = W.showDirectoryPicker;
    originalConfirm = W.confirm;
    setShowDirectoryPicker(vi.fn());
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    setShowDirectoryPicker(originalShowDirectoryPicker ?? null);
    W.confirm = originalConfirm;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a label that mentions 工場出荷状態', () => {
    render(
      <InstallButton label="セントラル" asset={ASSET} mode="clean" resetAsset={RESET_ASSET} />,
    );
    expect(
      screen.getByRole('button', {
        name: 'セントラルを工場出荷状態に戻して再インストール',
      }),
    ).toBeInTheDocument();
  });

  it('surfaces an error when resetAsset is missing on a clean install', async () => {
    render(<InstallButton label="セントラル" asset={ASSET} mode="clean" />);
    await userEvent.click(
      screen.getByRole('button', { name: /工場出荷状態に戻して再インストール/ }),
    );
    expect(screen.getByText(/リセット用ファームウェア/)).toBeInTheDocument();
  });

  it('opens the wizard at stage 1 (リセット uf2)', async () => {
    render(
      <InstallButton label="セントラル" asset={ASSET} mode="clean" resetAsset={RESET_ASSET} />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: /工場出荷状態に戻して再インストール/ }),
    );
    expect(screen.getByText(/ステップ 1\/2: リセット uf2/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /リセット uf2 を書き込み/ })).toBeInTheDocument();
  });

  it('stage 1 writes central-reset.uf2 and prompts the user to continue to stage 2', async () => {
    const { handle, writes } = makeFakeXiaoBoot({ withInfo: true });
    setShowDirectoryPicker(vi.fn(async () => handle));
    stubFetchOk([0x00, 0x01]);

    render(
      <InstallButton label="セントラル" asset={ASSET} mode="clean" resetAsset={RESET_ASSET} />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: /工場出荷状態に戻して再インストール/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: /リセット uf2 を書き込み/ }));

    await waitFor(() =>
      expect(screen.getAllByText(/ステップ 1\/2 完了/).length).toBeGreaterThan(0),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.name).toBe('central-reset.uf2');
    expect(
      screen.getByRole('button', { name: /次へ \(通常 uf2 のインストール\)/ }),
    ).toBeInTheDocument();
  });

  it('full clean flow: stage 1 → next → stage 2 → done writes both uf2s', async () => {
    const { handle, writes } = makeFakeXiaoBoot({ withInfo: true });
    setShowDirectoryPicker(vi.fn(async () => handle));
    stubFetchOk([0xab, 0xcd]);

    render(
      <InstallButton label="セントラル" asset={ASSET} mode="clean" resetAsset={RESET_ASSET} />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: /工場出荷状態に戻して再インストール/ }),
    );
    // Stage 1
    await userEvent.click(screen.getByRole('button', { name: /リセット uf2 を書き込み/ }));
    await waitFor(() =>
      expect(screen.getAllByText(/ステップ 1\/2 完了/).length).toBeGreaterThan(0),
    );
    await userEvent.click(screen.getByRole('button', { name: /次へ \(通常 uf2 のインストール\)/ }));

    // Stage 2
    expect(screen.getByText(/ステップ 2\/2/)).toBeInTheDocument();
    // Stage 2 button: "XIAO-BOOT を選択してuf2 を書き込み" (no leading 'リセット')
    const stage2Button = screen
      .getAllByRole('button')
      .find((b) => b.textContent === 'XIAO-BOOT を選択してuf2 を書き込み');
    if (!stage2Button) throw new Error('stage 2 button not found');
    await userEvent.click(stage2Button);

    await waitFor(() =>
      expect(screen.getByText(/工場出荷時のキーマップで起動します/)).toBeInTheDocument(),
    );
    expect(writes.map((w) => w.name)).toEqual(['central-reset.uf2', 'central.uf2']);
  });

  it('surfaces an error and lets the user retry stage 1 when reset uf2 write fails', async () => {
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

    render(
      <InstallButton label="セントラル" asset={ASSET} mode="clean" resetAsset={RESET_ASSET} />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: /工場出荷状態に戻して再インストール/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: /リセット uf2 を書き込み/ }));

    await waitFor(() => expect(screen.getByText(/エラー:/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'やり直す' })).toBeInTheDocument();
  });
});
