import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../state/connection';
import { useConnectionStore } from '../state/connection';
import { ConnectButton } from './ConnectButton';

const NOOP_TRANSPORT = {} as unknown as ConnectionState extends { transport: infer T } ? T : never;

function setState(state: ConnectionState) {
  useConnectionStore.setState({ state });
}

function stubStoreActions() {
  const promptConnect = vi.fn(async () => undefined);
  const trySilentReconnect = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);
  const clearError = vi.fn();
  useConnectionStore.setState((prev) => ({
    ...prev,
    promptConnect,
    trySilentReconnect,
    disconnect,
    clearError,
  }));
  return { promptConnect, trySilentReconnect, disconnect, clearError };
}

describe('ConnectButton', () => {
  beforeEach(() => {
    setState({ kind: 'idle' });
  });

  afterEach(() => {
    setState({ kind: 'idle' });
    vi.restoreAllMocks();
  });

  it('renders the unsupported notice when navigator.hid is absent (idle path falls back to button)', () => {
    setState({ kind: 'unsupported' });
    render(<ConnectButton />);
    expect(screen.getByText(/WebHID に対応していません/)).toBeInTheDocument();
  });

  it('renders "kobu に接続" button in idle state and calls promptConnect on click', async () => {
    setState({ kind: 'idle' });
    const { promptConnect } = stubStoreActions();
    render(<ConnectButton />);
    const button = screen.getByRole('button', { name: 'kobu に接続' });
    await userEvent.click(button);
    expect(promptConnect).toHaveBeenCalledTimes(1);
  });

  it('disables the button and shows 接続中… while connecting', () => {
    setState({ kind: 'connecting' });
    render(<ConnectButton />);
    const button = screen.getByRole('button', { name: '接続中…' });
    expect(button).toBeDisabled();
  });

  it('renders the ready panel with disconnect button', async () => {
    setState({
      kind: 'ready',
      transport: NOOP_TRANSPORT,
      handshake: {
        viaProtocolVersion: 0x0009,
        keyboardId: {
          vialProtocolVersion: 6,
          uid: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
          featureFlags: 0,
        },
        definition: {
          matrix: { rows: 4, cols: 10 },
          layouts: { keymap: [[], [], [], []] },
        },
        isKobu: true,
      },
      deviceName: 'kobu',
      definitionFromCache: false,
    } as ConnectionState);
    const { disconnect } = stubStoreActions();
    render(<ConnectButton />);
    expect(
      screen.getByText(
        (_, node) =>
          node?.tagName === 'P' && (node?.textContent?.includes('kobu に接続しました') ?? false),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/マトリクス 4×10/)).toBeInTheDocument();

    const button = screen.getByRole('button', { name: '切断' });
    await userEvent.click(button);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('shows the cache indicator when definitionFromCache is true', () => {
    setState({
      kind: 'ready',
      transport: NOOP_TRANSPORT,
      handshake: {
        viaProtocolVersion: 0x0009,
        keyboardId: {
          vialProtocolVersion: 6,
          uid: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
          featureFlags: 0,
        },
        definition: { matrix: { rows: 4, cols: 10 }, layouts: { keymap: [] } },
        isKobu: true,
      },
      deviceName: 'kobu',
      definitionFromCache: true,
    } as ConnectionState);
    render(<ConnectButton />);
    expect(screen.getByText(/キャッシュから読み込み/)).toBeInTheDocument();
  });

  it('renders the wrong-device warning and triggers disconnect on click', async () => {
    setState({
      kind: 'wrong-device',
      transport: NOOP_TRANSPORT,
      uidHex: '0102030405060708',
    } as ConnectionState);
    const { disconnect } = stubStoreActions();
    render(<ConnectButton />);
    expect(screen.getByText(/これは kobu ではありません/)).toBeInTheDocument();
    expect(screen.getByText(/0102030405060708/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '切断' }));
    expect(disconnect).toHaveBeenCalled();
  });

  it.each([
    ['webhid-unsupported', /Chrome \/ Edge \/ Brave \/ Opera/],
    ['open-failed', /他のタブが/],
    ['receive-timeout', /USB ケーブル/],
    ['disconnected', /ケーブルが抜けました/],
    ['send-failed', /書き込みに失敗/],
  ] as const)('renders the recovery hint for errorKind=%s', (errorKind, hintPattern) => {
    setState({ kind: 'error', message: 'simulated', errorKind });
    render(<ConnectButton />);
    expect(screen.getByText(hintPattern)).toBeInTheDocument();
  });

  it('renders generic error without a recovery hint when errorKind is unknown', () => {
    setState({ kind: 'error', message: 'simulated', errorKind: 'unknown' });
    render(<ConnectButton />);
    expect(screen.getByText(/unknown: simulated/)).toBeInTheDocument();
  });

  it('clicking 再試行 calls clearError', async () => {
    setState({ kind: 'error', message: 'simulated', errorKind: 'unknown' });
    const { clearError } = stubStoreActions();
    render(<ConnectButton />);
    await userEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(clearError).toHaveBeenCalledTimes(1);
  });

  it('trySilentReconnect runs only once even if the store transitions back to idle', async () => {
    setState({ kind: 'idle' });
    const { trySilentReconnect } = stubStoreActions();
    const { rerender } = render(<ConnectButton />);
    expect(trySilentReconnect).toHaveBeenCalledTimes(1);
    // Simulate a connected → disconnected transition (e.g. the user
    // clicks 切断, which the store turns into 'idle'). The effect
    // must NOT re-fire silent reconnect, otherwise the disconnect
    // button is useless.
    setState({
      kind: 'ready',
      transport: NOOP_TRANSPORT,
      handshake: {
        viaProtocolVersion: 0x0009,
        keyboardId: {
          vialProtocolVersion: 6,
          uid: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
          featureFlags: 0,
        },
        definition: { matrix: { rows: 4, cols: 10 }, layouts: { keymap: [] } },
        isKobu: true,
      },
      deviceName: 'kobu',
      definitionFromCache: false,
    } as ConnectionState);
    rerender(<ConnectButton />);
    setState({ kind: 'idle' });
    rerender(<ConnectButton />);
    expect(trySilentReconnect).toHaveBeenCalledTimes(1);
  });
});
