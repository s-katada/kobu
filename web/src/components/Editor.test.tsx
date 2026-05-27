import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { useConnectionStore } from '../state/connection';
import { useEditorStore } from '../state/editor';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { Editor } from './Editor';

const DEFINITION: KeyboardLayoutDef = {
  matrix: { rows: 4, cols: 10 },
  customKeycodes: [{ name: 'BT0', title: 'Bluetooth Channel 0', shortName: 'BT0' }],
  layouts: {
    keymap: [
      ['0,0', '0,1', '0,2', '0,3', '0,4', { x: 1 }, '0,5', '0,6', '0,7', '0,8', '0,9'],
      ['1,0', '1,1', '1,2', '1,3', '1,4', { x: 1 }, '1,5', '1,6', '1,7', '1,8', '1,9'],
      ['2,0', '2,1', '2,2', '2,3', '2,4', { x: 1 }, '2,5', '2,6', '2,7', '2,8', '2,9'],
      [{ x: 1 }, '3,1', '3,2', '3,3', '3,4', { x: 1 }, '3,5', '3,6', '3,7', '3,8'],
    ],
  },
};

class FakeTransport {
  layers = 4;
  rows = 4;
  cols = 10;
  keymap: number[] = Array.from({ length: 4 * 4 * 10 }, () => 0x04);

  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    const reply = new Uint8Array(new ArrayBuffer(32));
    const cmd = packet[0];
    if (cmd === 0x11) {
      reply[1] = this.layers;
    } else if (cmd === 0x12) {
      const offset = ((packet[1] ?? 0) << 8) | (packet[2] ?? 0);
      const size = packet[3] ?? 0;
      reply[0] = 0x12;
      reply[3] = size;
      for (let i = 0; i < size; i++) {
        const wordIndex = (offset + i) >> 1;
        const code = this.keymap[wordIndex] ?? 0;
        reply[4 + i] = (offset + i) % 2 === 0 ? (code >> 8) & 0xff : code & 0xff;
      }
    } else if (cmd === 0xfe && packet[1] === 0x05) {
      reply[0] = 0; // unlocked
    }
    return intoVialPacket(reply);
  }
}

function primeReady() {
  useConnectionStore.setState({
    state: {
      kind: 'ready',
      transport: new FakeTransport() as unknown as WebHidTransport,
      handshake: {
        viaProtocolVersion: 0x0009,
        keyboardId: {
          vialProtocolVersion: 6,
          uid: new Uint8Array([0xb9, 0xbc, 0x09, 0xb2, 0x9d, 0x37, 0x4c, 0xea]),
          featureFlags: 0,
        },
        definition: DEFINITION,
        isKobu: true,
      },
      deviceName: 'kobu',
      definitionFromCache: false,
    },
  });
}

describe('Editor integration', () => {
  beforeEach(() => {
    useConnectionStore.setState({ state: { kind: 'idle' } });
    useEditorStore.getState().detach();
  });

  afterEach(() => {
    useConnectionStore.setState({ state: { kind: 'idle' } });
    useEditorStore.getState().detach();
  });

  it('renders nothing while the connection is not ready', () => {
    const { container } = render(<Editor />);
    expect(container.firstChild).toBeNull();
  });

  it('attaches the editor store and renders toolbar + keymap once ready', async () => {
    primeReady();
    render(<Editor />);
    await waitFor(() => expect(useEditorStore.getState().phase.kind).toBe('ready'));
    expect(screen.getAllByRole('tab').length).toBe(4);
    // Keycaps render their centred label — A appears multiple times for the
    // uniform 0x04 / "A" keymap.
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
  });

  it('clicking a key cell selects it and surfaces it in the dock', async () => {
    primeReady();
    render(<Editor />);
    await waitFor(() => expect(useEditorStore.getState().phase.kind).toBe('ready'));
    const cells = screen.getAllByLabelText(/行 0 列 0/);
    if (!cells[0]) throw new Error('cell not found');
    await userEvent.click(cells[0]);
    // The selection lands in the editor store.
    expect(useEditorStore.getState().selected).toEqual({ layer: 0, row: 0, col: 0 });
    // And the dock summary text reflects it.
    expect(screen.getByText(/選択中:/)).toBeInTheDocument();
    expect(screen.getByText('行 0 列 0')).toBeInTheDocument();
  });

  it('arrow keys move the selection within the active layer', async () => {
    primeReady();
    render(<Editor />);
    await waitFor(() => expect(useEditorStore.getState().phase.kind).toBe('ready'));

    useEditorStore.getState().selectCell({ layer: 0, row: 1, col: 2 });
    await userEvent.keyboard('{ArrowRight}');
    expect(useEditorStore.getState().selected).toEqual({ layer: 0, row: 1, col: 3 });
    await userEvent.keyboard('{ArrowDown}');
    expect(useEditorStore.getState().selected).toEqual({ layer: 0, row: 2, col: 3 });
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
    expect(useEditorStore.getState().selected).toEqual({ layer: 0, row: 1, col: 2 });
  });

  it('Backspace clears the selected cell to KC_NO', async () => {
    primeReady();
    render(<Editor />);
    await waitFor(() => expect(useEditorStore.getState().phase.kind).toBe('ready'));

    useEditorStore.getState().selectCell({ layer: 0, row: 0, col: 0 });
    await userEvent.keyboard('{Backspace}');
    const km = useEditorStore.getState().local;
    expect(km?.[0]?.[0]?.[0]).toBe(0); // KC_NO
  });

  it('shows the BluetoothPanel when activeLayer is 3', async () => {
    primeReady();
    render(<Editor />);
    await waitFor(() => expect(useEditorStore.getState().phase.kind).toBe('ready'));

    useEditorStore.getState().setActiveLayer(3);

    await waitFor(() => expect(screen.getByText(/Bluetooth コントロール/)).toBeInTheDocument());
  });

  it('detaches the editor store when the connection leaves ready', async () => {
    primeReady();
    const { rerender } = render(<Editor />);
    await waitFor(() => expect(useEditorStore.getState().phase.kind).toBe('ready'));

    useConnectionStore.setState({ state: { kind: 'idle' } });
    rerender(<Editor />);
    await waitFor(() => expect(useEditorStore.getState().phase.kind).toBe('empty'));
  });
});
