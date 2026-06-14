import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as handleStore from '../install/handleStore';
import { clearXiaoBootHandle } from '../install/handleStore';
import { useConnectionStore } from '../state/connection';
import type { FirmwareAsset } from '../state/firmware';
import type { WebHidTransport } from '../transport/webhid';
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

// ─── Auto-bootloader-jump (Phase 6.3) ─────────────────────────────────────

describe('InstallButton — auto bootloader-jump (central, connected)', () => {
  // Fake transport that records sendAndReceive calls. The
  // `enterBootloader` helper expects either a successful round-trip
  // OR one of the documented transport errors — both are treated as
  // "firmware rebooted, we're good".
  function recordingTransport(): { transport: WebHidTransport; calls: Uint8Array[] } {
    const calls: Uint8Array[] = [];
    const transport = {
      sendAndReceive: vi.fn(async (packet: Uint8Array<ArrayBuffer>) => {
        calls.push(packet);
        // Simulate the firmware rebooting before it could ack: throw
        // the same TransportError kind enterBootloader swallows.
        const { TransportError } = await import('../transport/types');
        throw new TransportError('disconnected', 'firmware rebooted');
      }),
    } as unknown as WebHidTransport;
    return { transport, calls };
  }

  function readyConnection(transport: WebHidTransport) {
    useConnectionStore.setState({
      state: {
        kind: 'ready',
        transport,
        deviceName: 'kobu',
        definitionFromCache: false,
        handshake: {
          isKobu: true,
          viaProtocolVersion: 0x0009,
          keyboardId: {
            vialProtocolVersion: 6,
            uid: new Uint8Array([0xb9, 0xbc, 0x09, 0xb2, 0x9d, 0x37, 0x4c, 0xea]),
            featureFlags: 0,
          },
          // The install button doesn't read the definition, but the
          // ConnectionState shape requires it.
          definition: {
            matrix: { rows: 4, cols: 10 },
            customKeycodes: [],
            layouts: { keymap: [] },
          },
        },
      },
    });
  }

  let originalShowDirectoryPicker: WindowWithExtras['showDirectoryPicker'];

  beforeEach(async () => {
    originalShowDirectoryPicker = W.showDirectoryPicker;
    setShowDirectoryPicker(vi.fn());
    vi.stubGlobal('fetch', vi.fn());
    await clearXiaoBootHandle();
  });

  afterEach(async () => {
    setShowDirectoryPicker(originalShowDirectoryPicker ?? null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useConnectionStore.setState({ state: { kind: 'idle' } });
    await clearXiaoBootHandle();
  });

  it("sends BootloaderJump on click and skips the 'press RESET' step", async () => {
    const { handle, writes } = makeFakeXiaoBoot({ withInfo: true });
    setShowDirectoryPicker(vi.fn(async () => handle));
    stubFetchOk([0xaa, 0xbb]);
    const { transport, calls } = recordingTransport();
    readyConnection(transport);

    // `mountWaitMs={0}` skips the real-time OS-mount wait — in
    // production it's 3 s.
    render(<InstallButton label="セントラル" target="central" asset={ASSET} mountWaitMs={0} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));

    await waitFor(() =>
      expect(screen.getByText(/kobu をブートローダーモードに切り替えました/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/RESET ボタンを素早く 2 回押す/)).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(0x0b); // Vial BootloaderJump

    await userEvent.click(screen.getByRole('button', { name: /XIAO-BOOT を選択/ }));
    await waitFor(() => expect(screen.getByText(/書き込みが完了しました/)).toBeInTheDocument());
    expect(writes).toHaveLength(1);
  });

  it('skips the directory picker when a saved XIAO-BOOT handle is reusable', async () => {
    const { handle, writes } = makeFakeXiaoBoot({ withInfo: true });

    // Stub loadXiaoBootHandle directly instead of round-tripping
    // through IDB — the fake handle has vi.fn() methods which aren't
    // structured-cloneable, so an IDB store-then-load wouldn't
    // preserve them.
    vi.spyOn(handleStore, 'loadXiaoBootHandle').mockResolvedValue(handle);
    vi.spyOn(handleStore, 'queryHandlePermission').mockResolvedValue('granted');
    vi.spyOn(handleStore, 'isHandleAccessible').mockResolvedValue(true);

    setShowDirectoryPicker(
      vi.fn(async () => {
        throw new Error('picker should not be called when handle is reusable');
      }),
    );
    stubFetchOk([0xcc]);
    const { transport } = recordingTransport();
    readyConnection(transport);

    render(<InstallButton label="セントラル" target="central" asset={ASSET} mountWaitMs={0} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));

    // Goes straight to fetch + write — no picker, no ready-to-pick.
    await waitFor(() => expect(screen.getByText(/書き込みが完了しました/)).toBeInTheDocument());
    expect(writes).toHaveLength(1);
  });

  it('surfaces a retryable error (not a stuck spinner) when the bootloader jump throws unexpectedly', async () => {
    // enterBootloader only swallows receive-timeout / send-failed /
    // disconnected. Anything else (here: concurrent-request, which the
    // single-slot mailbox throws if a Vial command races ours) must
    // land on the error screen with a retry — never freeze the wizard
    // on the "切り替え中…" spinner.
    const failing = {
      sendAndReceive: vi.fn(async () => {
        const { TransportError } = await import('../transport/types');
        throw new TransportError('concurrent-request', 'another command in flight');
      }),
    } as unknown as WebHidTransport;
    readyConnection(failing);

    render(<InstallButton label="セントラル" target="central" asset={ASSET} mountWaitMs={0} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));

    await waitFor(() =>
      expect(
        screen.getByText(/ブートローダーモードへの切り替えに失敗しました/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'やり直す' })).toBeInTheDocument();
    expect(screen.queryByText(/ブートローダーモードに切り替え中/)).not.toBeInTheDocument();
  });
});

describe('InstallButton — auto-jump gate (negative cases)', () => {
  let originalShowDirectoryPicker: WindowWithExtras['showDirectoryPicker'];

  beforeEach(() => {
    originalShowDirectoryPicker = W.showDirectoryPicker;
    setShowDirectoryPicker(vi.fn());
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    setShowDirectoryPicker(originalShowDirectoryPicker ?? null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useConnectionStore.setState({ state: { kind: 'idle' } });
  });

  it('peripheral target auto-jumps via the split-link relay when central is ready', async () => {
    const send = vi.fn().mockResolvedValue(new Uint8Array(32));
    const transport = { sendAndReceive: send } as unknown as WebHidTransport;
    useConnectionStore.setState({
      state: {
        kind: 'ready',
        transport,
        deviceName: 'kobu',
        definitionFromCache: false,
        handshake: {
          isKobu: true,
          viaProtocolVersion: 0x0009,
          keyboardId: {
            vialProtocolVersion: 6,
            uid: new Uint8Array(8),
            featureFlags: 0,
          },
          definition: {
            matrix: { rows: 4, cols: 10 },
            customKeycodes: [],
            layouts: { keymap: [] },
          },
        },
      },
    });

    render(
      <InstallButton label="ペリフェラル" target="peripheral" asset={ASSET} mountWaitMs={0} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /ペリフェラルをインストール/ }));

    // The split-link relay is triggered via Via CustomSetValue
    // (channel 0xC0, id 0x12, value 1) — central's patched RMK turns
    // that into a SplitMessage::PeripheralBootloaderJump.
    await waitFor(() => {
      expect(send).toHaveBeenCalled();
    });
    const packet = send.mock.calls[0]?.[0] as Uint8Array;
    expect(packet[0]).toBe(0x07); // ViaCommand.CustomSetValue
    expect(packet[1]).toBe(0xc0); // KOBU_CHANNEL
    expect(packet[2]).toBe(0x12); // peripheral bootloader-jump id
    expect(packet[3]).toBe(0x01);
  });

  it('central target with no connection falls back to the manual reset wizard (first-time install path)', async () => {
    useConnectionStore.setState({ state: { kind: 'idle' } });

    render(<InstallButton label="セントラル" target="central" asset={ASSET} />);
    await userEvent.click(screen.getByRole('button', { name: /セントラルをインストール/ }));

    expect(screen.getByText(/RESET ボタンを素早く 2 回押す/)).toBeInTheDocument();
  });
});
