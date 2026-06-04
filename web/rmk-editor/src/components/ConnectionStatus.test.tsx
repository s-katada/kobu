import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionState } from '../state/connection';
import { useConnectionStore } from '../state/connection';
import { ConnectionStatus } from './ConnectionStatus';

const PRISTINE: ConnectionState = { kind: 'idle' };

function setState(state: ConnectionState) {
  useConnectionStore.setState({ state });
}

describe('ConnectionStatus', () => {
  beforeEach(() => {
    setState(PRISTINE);
  });

  afterEach(() => {
    setState(PRISTINE);
  });

  it('renders the unsupported badge', () => {
    setState({ kind: 'unsupported' });
    render(<ConnectionStatus />);
    expect(screen.getByText('WebHID 非対応')).toBeInTheDocument();
  });

  it('renders the idle badge', () => {
    setState({ kind: 'idle' });
    render(<ConnectionStatus />);
    expect(screen.getByText('未接続')).toBeInTheDocument();
  });

  it('renders the connecting badge', () => {
    setState({ kind: 'connecting' });
    render(<ConnectionStatus />);
    expect(screen.getByText('接続中…')).toBeInTheDocument();
  });

  it('renders the ready badge with device name and a tooltip listing protocol versions', () => {
    setState({
      kind: 'ready',
      transport: {} as unknown as Parameters<typeof setState>[0] extends { transport: infer T }
        ? T
        : never,
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
    render(<ConnectionStatus />);
    const badge = screen.getByText(/kobu/);
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('title')).toMatch(/Via 0x0009/);
    expect(badge.getAttribute('title')).toMatch(/Vial 0x0006/);
  });

  it('adds the (キャッシュ) suffix when definitionFromCache is true', () => {
    setState({
      kind: 'ready',
      transport: {} as never,
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
    render(<ConnectionStatus />);
    expect(screen.getByText(/キャッシュ/)).toBeInTheDocument();
  });

  it('renders the wrong-device badge with the UID title', () => {
    setState({
      kind: 'wrong-device',
      transport: {} as never,
      uidHex: 'deadbeefcafebabe',
    } as ConnectionState);
    render(<ConnectionStatus />);
    const badge = screen.getByText('別のデバイス');
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('title')).toContain('deadbeefcafebabe');
  });

  it('renders the error badge with errorKind and message tooltip', () => {
    setState({
      kind: 'error',
      message: 'simulated open failure',
      errorKind: 'open-failed',
    });
    render(<ConnectionStatus />);
    const badge = screen.getByText(/open-failed/);
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('title')).toContain('simulated open failure');
  });
});
