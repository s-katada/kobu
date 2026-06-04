import { beforeEach, describe, expect, it } from 'vitest';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { selectDirtyMask, selectDuplicateIndices, selectIsDirty, useComboStore } from './combos';

class FakeTransport {
  combos = 4;
  /** Flat list of {inputs[4], output}; 0 means unused. */
  stored: { inputs: [number, number, number, number]; output: number }[];
  locked = false;
  writes: Array<{ idx: number; inputs: number[]; output: number }> = [];
  failOn: number | null = null;

  constructor() {
    this.stored = Array.from({ length: this.combos }, () => ({
      inputs: [0, 0, 0, 0] as [number, number, number, number],
      output: 0,
    }));
  }

  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    const reply = new Uint8Array(new ArrayBuffer(32));
    const cmd = packet[0];
    const sub = packet[1];
    const sub2 = packet[2];

    if (cmd === 0xfe && sub === 0x0d && sub2 === 0x00) {
      // GetNumberOfEntries
      reply[0] = 8;
      reply[1] = this.combos;
      reply[2] = 0;
      reply[31] = 1;
    } else if (cmd === 0xfe && sub === 0x0d && sub2 === 0x03) {
      // ComboGet
      const idx = packet[3] ?? 0;
      const entry = this.stored[idx];
      if (entry) {
        for (let i = 0; i < 4; i++) {
          const kc = entry.inputs[i as 0 | 1 | 2 | 3];
          reply[1 + i * 2] = kc & 0xff;
          reply[2 + i * 2] = (kc >> 8) & 0xff;
        }
        reply[9] = entry.output & 0xff;
        reply[10] = (entry.output >> 8) & 0xff;
      }
    } else if (cmd === 0xfe && sub === 0x0d && sub2 === 0x04) {
      // ComboSet
      const idx = packet[3] ?? 0;
      this.writes.push({
        idx,
        inputs: [packet[4] ?? 0, packet[6] ?? 0, packet[8] ?? 0, packet[10] ?? 0].map(
          (lo, i) => lo | ((packet[5 + i * 2] ?? 0) << 8),
        ),
        output: (packet[12] ?? 0) | ((packet[13] ?? 0) << 8),
      });
      if (this.failOn !== null && this.writes.length > this.failOn) {
        throw new Error(`forced failure after write ${this.writes.length}`);
      }
      const slot = this.stored[idx];
      if (slot) {
        for (let i = 0; i < 4; i++) {
          slot.inputs[i as 0 | 1 | 2 | 3] =
            (packet[4 + i * 2] ?? 0) | ((packet[5 + i * 2] ?? 0) << 8);
        }
        slot.output = (packet[12] ?? 0) | ((packet[13] ?? 0) << 8);
      }
    } else if (cmd === 0xfe && sub === 0x05) {
      reply[0] = this.locked ? 1 : 0;
      reply[1] = 0;
      reply[2] = 0xff;
      reply[3] = 0xff;
    }

    return intoVialPacket(reply);
  }
}

function fakeTransport(): { fake: FakeTransport; transport: WebHidTransport } {
  const fake = new FakeTransport();
  return { fake, transport: fake as unknown as WebHidTransport };
}

beforeEach(() => {
  useComboStore.getState().detach();
});

describe('attach', () => {
  it('reads count and fetches every entry', async () => {
    const { fake, transport } = fakeTransport();
    fake.stored[0] = { inputs: [0x14, 0x1a, 0, 0], output: 0x29 };
    await useComboStore.getState().attach(transport);
    const s = useComboStore.getState();
    expect(s.phase.kind).toBe('ready');
    expect(s.count).toBe(4);
    expect(s.local[0]).toEqual({ inputs: [0x14, 0x1a, 0, 0], output: 0x29 });
    expect(s.local[1]).toEqual({ inputs: [0, 0, 0, 0], output: 0 });
  });
});

describe('editing', () => {
  beforeEach(async () => {
    const { transport } = fakeTransport();
    await useComboStore.getState().attach(transport);
  });

  it('setInput updates one input slot', () => {
    useComboStore.getState().setInput(0, 0, 0x14);
    expect(useComboStore.getState().local[0]?.inputs[0]).toBe(0x14);
  });

  it('setOutput updates the output keycode', () => {
    useComboStore.getState().setOutput(0, 0x29);
    expect(useComboStore.getState().local[0]?.output).toBe(0x29);
  });

  it('clearCombo restores an empty entry', () => {
    useComboStore.getState().setInput(0, 0, 0x14);
    useComboStore.getState().setOutput(0, 0x29);
    useComboStore.getState().clearCombo(0);
    expect(useComboStore.getState().local[0]).toEqual({ inputs: [0, 0, 0, 0], output: 0 });
  });

  it('resetCombo restores from baseline', () => {
    useComboStore.getState().setInput(0, 0, 0x14);
    useComboStore.getState().resetCombo(0);
    expect(useComboStore.getState().local[0]?.inputs[0]).toBe(0);
  });
});

describe('selectors', () => {
  it('selectIsDirty flips when local diverges', async () => {
    const { transport } = fakeTransport();
    await useComboStore.getState().attach(transport);
    expect(selectIsDirty(useComboStore.getState())).toBe(false);
    useComboStore.getState().setOutput(0, 0x29);
    expect(selectIsDirty(useComboStore.getState())).toBe(true);
  });

  it('selectDirtyMask reports per-slot dirty flags', async () => {
    const { transport } = fakeTransport();
    await useComboStore.getState().attach(transport);
    useComboStore.getState().setOutput(2, 0x29);
    const mask = selectDirtyMask(useComboStore.getState());
    expect(mask[0]).toBe(false);
    expect(mask[2]).toBe(true);
  });

  it('selectDuplicateIndices flags entries with identical non-zero input sets', async () => {
    const { transport } = fakeTransport();
    await useComboStore.getState().attach(transport);
    // Two combos that share the same input set (order-independent)
    useComboStore.getState().updateCombo(0, { inputs: [0x14, 0x1a, 0, 0], output: 0x29 });
    useComboStore.getState().updateCombo(1, { inputs: [0x1a, 0x14, 0, 0], output: 0x2a });
    // A third with different inputs
    useComboStore.getState().updateCombo(2, { inputs: [0x14, 0x1b, 0, 0], output: 0x2b });
    const dups = selectDuplicateIndices(useComboStore.getState());
    expect(Array.from(dups).sort()).toEqual([0, 1]);
  });

  it('empty entries are not considered duplicates of each other', async () => {
    const { transport } = fakeTransport();
    await useComboStore.getState().attach(transport);
    // All slots start empty
    expect(selectDuplicateIndices(useComboStore.getState()).size).toBe(0);
  });
});

describe('save', () => {
  it('refuses when locked', async () => {
    const { fake, transport } = fakeTransport();
    fake.locked = true;
    await useComboStore.getState().attach(transport);
    useComboStore.getState().setOutput(0, 0x29);
    await useComboStore.getState().save();
    expect(useComboStore.getState().phase.kind).toBe('error');
    expect(fake.writes).toEqual([]);
  });

  it('writes dirty entries one by one and updates baseline', async () => {
    const { fake, transport } = fakeTransport();
    await useComboStore.getState().attach(transport);
    useComboStore.getState().updateCombo(1, { inputs: [0x14, 0x1a, 0, 0], output: 0x29 });
    useComboStore.getState().updateCombo(3, { inputs: [0x04, 0x05, 0, 0], output: 0x06 });
    await useComboStore.getState().save();
    expect(useComboStore.getState().phase.kind).toBe('ready');
    expect(fake.writes.map((w) => w.idx)).toEqual([1, 3]);
    expect(selectIsDirty(useComboStore.getState())).toBe(false);
  });

  it('partial-failure keeps successful writes in baseline', async () => {
    const { fake, transport } = fakeTransport();
    await useComboStore.getState().attach(transport);
    useComboStore.getState().updateCombo(1, { inputs: [0x14, 0x1a, 0, 0], output: 0x29 });
    useComboStore.getState().updateCombo(2, { inputs: [0x1b, 0x1c, 0, 0], output: 0x2a });
    fake.failOn = 1; // first write succeeds, second fails
    await useComboStore.getState().save();
    const s = useComboStore.getState();
    expect(s.phase.kind).toBe('error');
    // slot 1 was written, so baseline now matches local for that slot
    expect(s.baseline[1]?.output).toBe(0x29);
    // slot 2 still diverges from baseline → dirty
    expect(selectDirtyMask(s)[2]).toBe(true);
  });
});
