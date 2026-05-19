import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { selectDirtyLayerMask, selectIsDirty, useEditorStore } from './editor';

/**
 * Fake transport that lets the editor store talk to a controllable
 * "device". Tracks `setKeycode` writes so the test can assert what was
 * sent on save.
 */
class FakeTransport {
  layers = 4;
  rows = 4;
  cols = 10;
  /** Flat layers*rows*cols u16 buffer. */
  keymap: number[];
  locked = false;
  failOn: number | null = null;
  writes: Array<{ layer: number; row: number; col: number; code: number }> = [];

  constructor() {
    this.keymap = Array.from(
      { length: this.layers * this.rows * this.cols },
      (_, i) => (i % 26) + 0x04,
    );
  }

  cellIndex(layer: number, row: number, col: number): number {
    return (layer * this.rows + row) * this.cols + col;
  }

  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    const reply = new Uint8Array(new ArrayBuffer(32));
    const cmd = packet[0];

    if (cmd === 0x11) {
      // DynamicKeymapGetLayerCount
      reply[1] = this.layers;
    } else if (cmd === 0x12) {
      // DynamicKeymapGetBuffer
      const offset = ((packet[1] ?? 0) << 8) | (packet[2] ?? 0);
      const size = packet[3] ?? 0;
      reply[0] = 0x12;
      reply[1] = packet[1] ?? 0;
      reply[2] = packet[2] ?? 0;
      reply[3] = size;
      for (let i = 0; i < size; i++) {
        const byteIndex = offset + i;
        const wordIndex = byteIndex >> 1;
        const code = this.keymap[wordIndex] ?? 0;
        reply[4 + i] = byteIndex % 2 === 0 ? (code >> 8) & 0xff : code & 0xff;
      }
    } else if (cmd === 0x05) {
      // DynamicKeymapSetKeyCode
      const layer = packet[1] ?? 0;
      const row = packet[2] ?? 0;
      const col = packet[3] ?? 0;
      const code = ((packet[4] ?? 0) << 8) | (packet[5] ?? 0);
      this.writes.push({ layer, row, col, code });
      if (this.failOn !== null && this.writes.length > this.failOn) {
        throw new Error(`forced failure after write ${this.writes.length}`);
      }
      this.keymap[this.cellIndex(layer, row, col)] = code;
      reply.set(packet.subarray(0, 6));
    } else if (cmd === 0xfe && packet[1] === 0x05) {
      // Vial GetUnlockStatus
      reply[0] = this.locked ? 1 : 0;
      reply[1] = 0;
      reply[2] = 0xff;
      reply[3] = 0xff;
    }

    return intoVialPacket(reply);
  }
}

function fakeTransport(): WebHidTransport {
  return new FakeTransport() as unknown as WebHidTransport;
}

function definition(): KeyboardLayoutDef {
  return {
    matrix: { rows: 4, cols: 10 },
    layouts: { keymap: [] },
    customKeycodes: [],
  };
}

describe('useEditorStore', () => {
  beforeEach(() => {
    useEditorStore.getState().detach();
  });

  it('loads layers + keymap on attach', async () => {
    const t = fakeTransport();
    await useEditorStore.getState().attach(t, definition());
    const state = useEditorStore.getState();
    expect(state.phase.kind).toBe('ready');
    expect(state.dimensions).toEqual({ layers: 4, rows: 4, cols: 10 });
    expect(state.baseline?.length).toBe(4);
    expect(state.local).toEqual(state.baseline);
    expect(selectIsDirty(state)).toBe(false);
  });

  it('tracks dirty cells when a key is edited', async () => {
    const t = fakeTransport();
    await useEditorStore.getState().attach(t, definition());
    useEditorStore.getState().setKey({ layer: 0, row: 0, col: 0 }, 0x29);
    const state = useEditorStore.getState();
    expect(selectIsDirty(state)).toBe(true);
    expect(selectDirtyLayerMask(state)).toBe(0b0001);
  });

  it('supports undo / redo of single-key edits', async () => {
    const t = fakeTransport();
    await useEditorStore.getState().attach(t, definition());
    const pos = { layer: 0, row: 0, col: 0 };
    const before = useEditorStore.getState().baseline?.[0]?.[0]?.[0];

    useEditorStore.getState().setKey(pos, 0x29);
    expect(useEditorStore.getState().local?.[0]?.[0]?.[0]).toBe(0x29);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().local?.[0]?.[0]?.[0]).toBe(before);

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().local?.[0]?.[0]?.[0]).toBe(0x29);
  });

  it('save() sends one SetKeyCode per dirty cell and clears dirty', async () => {
    const fake = new FakeTransport();
    await useEditorStore.getState().attach(fake as unknown as WebHidTransport, definition());

    useEditorStore.getState().setKey({ layer: 0, row: 0, col: 0 }, 0x29);
    useEditorStore.getState().setKey({ layer: 1, row: 2, col: 3 }, 0x2a);

    await useEditorStore.getState().save();

    expect(fake.writes).toHaveLength(2);
    expect(fake.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: 0, row: 0, col: 0, code: 0x29 }),
        expect.objectContaining({ layer: 1, row: 2, col: 3, code: 0x2a }),
      ]),
    );

    const state = useEditorStore.getState();
    expect(state.phase.kind).toBe('ready');
    expect(selectIsDirty(state)).toBe(false);
  });

  it('save() refuses to run while the device is locked', async () => {
    const fake = new FakeTransport();
    fake.locked = true;
    await useEditorStore.getState().attach(fake as unknown as WebHidTransport, definition());
    useEditorStore.getState().setKey({ layer: 0, row: 0, col: 0 }, 0x29);

    await useEditorStore.getState().save();

    expect(fake.writes).toHaveLength(0);
    expect(useEditorStore.getState().phase.kind).toBe('error');
  });

  it('save() commits successful writes to the baseline even when a later write fails', async () => {
    const fake = new FakeTransport();
    fake.failOn = 1;
    await useEditorStore.getState().attach(fake as unknown as WebHidTransport, definition());

    useEditorStore.getState().setKey({ layer: 0, row: 0, col: 0 }, 0x29);
    useEditorStore.getState().setKey({ layer: 0, row: 0, col: 1 }, 0x2a);
    useEditorStore.getState().setKey({ layer: 0, row: 0, col: 2 }, 0x2b);

    await useEditorStore.getState().save();

    const state = useEditorStore.getState();
    expect(state.phase.kind).toBe('error');
    // The first write landed on device + baseline; the failed one is
    // still dirty so the user can retry.
    expect(state.baseline?.[0]?.[0]?.[0]).toBe(0x29);
    expect(state.local?.[0]?.[0]?.[0]).toBe(0x29);
  });

  it('setActiveLayer clamps to the available layers and clears selection', async () => {
    const t = fakeTransport();
    await useEditorStore.getState().attach(t, definition());
    useEditorStore.getState().selectCell({ layer: 0, row: 0, col: 0 });

    useEditorStore.getState().setActiveLayer(99);
    expect(useEditorStore.getState().activeLayer).toBe(3);
    expect(useEditorStore.getState().selected).toBeNull();
  });
});
