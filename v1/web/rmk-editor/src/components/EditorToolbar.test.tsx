import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { useEditorStore } from '../state/editor';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { EditorToolbar } from './EditorToolbar';

const DEFINITION: KeyboardLayoutDef = {
  matrix: { rows: 4, cols: 10 },
  layouts: { keymap: [] },
  customKeycodes: [],
};

class FakeTransport {
  layers = 4;
  rows = 4;
  cols = 10;
  keymap: number[] = Array.from({ length: 4 * 4 * 10 }, (_, i) => (i % 26) + 0x04);
  locked = false;
  writes: Array<{ layer: number; row: number; col: number; code: number }> = [];

  cellIndex(layer: number, row: number, col: number): number {
    return (layer * this.rows + row) * this.cols + col;
  }

  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    const reply = new Uint8Array(new ArrayBuffer(32));
    const cmd = packet[0];
    if (cmd === 0x11) {
      reply[1] = this.layers;
    } else if (cmd === 0x12) {
      const offset = ((packet[1] ?? 0) << 8) | (packet[2] ?? 0);
      const size = packet[3] ?? 0;
      reply[0] = 0x12;
      reply[1] = packet[1] ?? 0;
      reply[2] = packet[2] ?? 0;
      reply[3] = size;
      for (let i = 0; i < size; i++) {
        const wordIndex = (offset + i) >> 1;
        const code = this.keymap[wordIndex] ?? 0;
        reply[4 + i] = (offset + i) % 2 === 0 ? (code >> 8) & 0xff : code & 0xff;
      }
    } else if (cmd === 0x05) {
      const layer = packet[1] ?? 0;
      const row = packet[2] ?? 0;
      const col = packet[3] ?? 0;
      const code = ((packet[4] ?? 0) << 8) | (packet[5] ?? 0);
      this.writes.push({ layer, row, col, code });
      this.keymap[this.cellIndex(layer, row, col)] = code;
      reply.set(packet.subarray(0, 6));
    } else if (cmd === 0xfe && packet[1] === 0x05) {
      reply[0] = this.locked ? 1 : 0;
    }
    return intoVialPacket(reply);
  }
}

async function setupReady() {
  const fake = new FakeTransport();
  await useEditorStore.getState().attach(fake as unknown as WebHidTransport, DEFINITION);
  return fake;
}

describe('EditorToolbar', () => {
  beforeEach(() => {
    useEditorStore.getState().detach();
  });

  afterEach(() => {
    useEditorStore.getState().detach();
  });

  it('renders nothing before the editor is attached', () => {
    const { container } = render(<EditorToolbar />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one tab per layer and highlights the active one via aria-selected', async () => {
    await setupReady();
    render(<EditorToolbar />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking a layer tab switches active layer', async () => {
    await setupReady();
    render(<EditorToolbar />);
    const tabs = screen.getAllByRole('tab');
    if (!tabs[2]) throw new Error('expected layer 2 tab');
    await userEvent.click(tabs[2]);
    expect(useEditorStore.getState().activeLayer).toBe(2);
  });

  it('Save / Undo / Redo are disabled when nothing is dirty', async () => {
    await setupReady();
    render(<EditorToolbar />);
    expect(screen.getByRole('button', { name: '保存済み' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'やり直し' })).toBeDisabled();
  });

  it('shows a dirty bullet on tabs whose layer has unsaved edits', async () => {
    await setupReady();
    useEditorStore.getState().setKey({ layer: 1, row: 0, col: 0 }, 0x29);
    render(<EditorToolbar />);
    const tabs = screen.getAllByRole('tab');
    if (!tabs[1]) throw new Error('expected layer 1 tab');
    // dirty bullet is a span with title="このレイヤーに未保存の変更があります"
    expect(tabs[1].querySelector('span[title]')).not.toBeNull();
  });

  it('clicking Save sends one SetKeyCode per dirty cell', async () => {
    const fake = await setupReady();
    useEditorStore.getState().setKey({ layer: 0, row: 0, col: 0 }, 0x29);
    useEditorStore.getState().setKey({ layer: 1, row: 0, col: 0 }, 0x2a);
    render(<EditorToolbar />);

    const saveButton = screen.getByRole('button', { name: '保存' });
    expect(saveButton).not.toBeDisabled();
    await userEvent.click(saveButton);

    expect(fake.writes).toHaveLength(2);
    expect(useEditorStore.getState().phase.kind).toBe('ready');
  });

  it('Undo / Redo buttons drive the corresponding store actions', async () => {
    await setupReady();
    const pos = { layer: 0, row: 0, col: 0 };
    const before = useEditorStore.getState().baseline?.[0]?.[0]?.[0];

    useEditorStore.getState().setKey(pos, 0x29);
    render(<EditorToolbar />);

    await userEvent.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(useEditorStore.getState().local?.[0]?.[0]?.[0]).toBe(before);

    await userEvent.click(screen.getByRole('button', { name: 'やり直し' }));
    expect(useEditorStore.getState().local?.[0]?.[0]?.[0]).toBe(0x29);
  });

  it('numeric keyboard shortcut 2 switches to layer 1', async () => {
    await setupReady();
    render(<EditorToolbar />);
    fireEvent.keyDown(window, { key: '2' });
    expect(useEditorStore.getState().activeLayer).toBe(1);
  });

  it('numeric keyboard shortcut beyond layer count is ignored', async () => {
    await setupReady();
    render(<EditorToolbar />);
    fireEvent.keyDown(window, { key: '9' });
    expect(useEditorStore.getState().activeLayer).toBe(0);
  });

  it('Ctrl-Z and Ctrl-Shift-Z drive undo and redo', async () => {
    await setupReady();
    const pos = { layer: 0, row: 0, col: 0 };
    useEditorStore.getState().setKey(pos, 0x29);

    render(<EditorToolbar />);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
    expect(useEditorStore.getState().redoStack).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
  });

  it('keyboard shortcuts inside <input> elements are ignored', async () => {
    await setupReady();
    render(
      <div>
        <input data-testid="text-field" />
        <EditorToolbar />
      </div>,
    );
    const input = screen.getByTestId('text-field');
    input.focus();
    fireEvent.keyDown(input, { key: '2' });
    expect(useEditorStore.getState().activeLayer).toBe(0);
  });

  it('shows save progress while saving', async () => {
    await setupReady();
    useEditorStore.getState().setKey({ layer: 0, row: 0, col: 0 }, 0x29);
    useEditorStore.setState({ phase: { kind: 'saving', sent: 1, total: 3 } });
    render(<EditorToolbar />);
    expect(screen.getByRole('button', { name: /保存中 1\/3/ })).toBeDisabled();
  });

  it('displays the error message when the phase is error', async () => {
    await setupReady();
    useEditorStore.setState({ phase: { kind: 'error', message: '保存に失敗しました' } });
    render(<EditorToolbar />);
    expect(screen.getByText('保存に失敗しました')).toBeInTheDocument();
  });
});
