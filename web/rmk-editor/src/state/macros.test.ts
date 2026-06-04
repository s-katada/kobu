import { beforeEach, describe, expect, it } from 'vitest';
import { decodeBuffer, encodeBuffer, type MacroSequence } from '../protocol/macros';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { selectDirtyMask, selectIsDirty, selectUsedBytes, useMacroStore } from './macros';

/**
 * Fake transport that backs the macro buffer with a real Uint8Array
 * so we can verify that the store's save flow rewrites the right
 * bytes. Also models the unlock gate the store goes through before
 * issuing the write.
 */
class FakeTransport {
  count = 8;
  bufferSize = 64;
  buffer: Uint8Array;
  locked = false;
  failOnChunk: number | null = null;
  chunks = 0;
  writes: Array<{ offset: number; data: number[] }> = [];

  constructor(initial?: Uint8Array) {
    this.buffer = new Uint8Array(this.bufferSize);
    if (initial) this.buffer.set(initial.subarray(0, this.bufferSize));
  }

  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    const reply = new Uint8Array(new ArrayBuffer(32));
    const cmd = packet[0];

    if (cmd === 0x0c) {
      // MacroGetCount
      reply[1] = this.count;
    } else if (cmd === 0x0d) {
      // MacroGetBufferSize — BE u16 in [1..3]
      reply[1] = (this.bufferSize >> 8) & 0xff;
      reply[2] = this.bufferSize & 0xff;
    } else if (cmd === 0x0e) {
      // MacroGetBuffer
      const offset = ((packet[1] ?? 0) << 8) | (packet[2] ?? 0);
      const size = packet[3] ?? 0;
      reply[0] = 0x0e;
      reply[1] = packet[1] ?? 0;
      reply[2] = packet[2] ?? 0;
      reply[3] = size;
      reply.set(this.buffer.subarray(offset, offset + size), 4);
    } else if (cmd === 0x0f) {
      // MacroSetBuffer
      this.chunks += 1;
      if (this.failOnChunk !== null && this.chunks > this.failOnChunk) {
        throw new Error(`forced failure on chunk ${this.chunks}`);
      }
      const offset = ((packet[1] ?? 0) << 8) | (packet[2] ?? 0);
      const size = packet[3] ?? 0;
      const data = Array.from(packet.subarray(4, 4 + size));
      this.writes.push({ offset, data });
      // Mimic RMK behaviour: offset=0 zeroes the cache, every chunk
      // overlays the local buffer.
      if (offset === 0) {
        this.buffer.fill(0);
      }
      this.buffer.set(packet.subarray(4, 4 + size), offset);
      reply.set(packet.subarray(0, 4 + size));
    } else if (cmd === 0xfe && packet[1] === 0x05) {
      reply[0] = this.locked ? 1 : 0;
      reply[1] = 0;
      reply[2] = 0xff;
      reply[3] = 0xff;
    }

    return intoVialPacket(reply);
  }
}

function fakeTransport(initial?: Uint8Array): { fake: FakeTransport; transport: WebHidTransport } {
  const fake = new FakeTransport(initial);
  return { fake, transport: fake as unknown as WebHidTransport };
}

beforeEach(() => {
  useMacroStore.getState().detach();
});

describe('attach', () => {
  it('reads count, buffer size, and decodes the buffer', async () => {
    const initial = encodeBuffer(
      [[{ kind: 'tap', keycode: 0x04 }], [{ kind: 'down', keycode: 0xe1 }]],
      64,
    );
    const { transport } = fakeTransport(initial);
    await useMacroStore.getState().attach(transport);
    const s = useMacroStore.getState();
    expect(s.phase.kind).toBe('ready');
    expect(s.count).toBe(8);
    expect(s.bufferSize).toBe(64);
    expect(s.local).toHaveLength(8);
    expect(s.local[0]).toEqual([{ kind: 'tap', keycode: 0x04 }]);
    expect(s.local[1]).toEqual([{ kind: 'down', keycode: 0xe1 }]);
    expect(s.local[2]).toEqual([]);
  });
});

describe('editing actions', () => {
  beforeEach(async () => {
    const { transport } = fakeTransport();
    await useMacroStore.getState().attach(transport);
  });

  it('addAction appends to the named macro', () => {
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    useMacroStore.getState().addAction(0, { kind: 'delay', ms: 30 });
    expect(useMacroStore.getState().local[0]).toEqual([
      { kind: 'tap', keycode: 0x04 },
      { kind: 'delay', ms: 30 },
    ]);
  });

  it('updateAction replaces in place', () => {
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    useMacroStore.getState().updateAction(0, 0, { kind: 'tap', keycode: 0x05 });
    expect(useMacroStore.getState().local[0]).toEqual([{ kind: 'tap', keycode: 0x05 }]);
  });

  it('removeAction drops by index', () => {
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x05 });
    useMacroStore.getState().removeAction(0, 0);
    expect(useMacroStore.getState().local[0]).toEqual([{ kind: 'tap', keycode: 0x05 }]);
  });

  it('moveAction reorders', () => {
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x05 });
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x06 });
    useMacroStore.getState().moveAction(0, 0, 2);
    expect(useMacroStore.getState().local[0]).toEqual([
      { kind: 'tap', keycode: 0x05 },
      { kind: 'tap', keycode: 0x06 },
      { kind: 'tap', keycode: 0x04 },
    ]);
  });

  it('setMacro replaces the entire sequence', () => {
    const next: MacroSequence = [{ kind: 'delay', ms: 10 }];
    useMacroStore.getState().setMacro(0, next);
    expect(useMacroStore.getState().local[0]).toEqual(next);
  });

  it('resetMacro restores from baseline', () => {
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    useMacroStore.getState().resetMacro(0);
    expect(useMacroStore.getState().local[0]).toEqual([]);
  });
});

describe('selectors', () => {
  it('selectIsDirty flips once local diverges', async () => {
    const { transport } = fakeTransport();
    await useMacroStore.getState().attach(transport);
    expect(selectIsDirty(useMacroStore.getState())).toBe(false);
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    expect(selectIsDirty(useMacroStore.getState())).toBe(true);
  });

  it('selectDirtyMask reports per-macro dirty flags', async () => {
    const { transport } = fakeTransport();
    await useMacroStore.getState().attach(transport);
    useMacroStore.getState().addAction(2, { kind: 'tap', keycode: 0x04 });
    const mask = selectDirtyMask(useMacroStore.getState());
    expect(mask[0]).toBe(false);
    expect(mask[2]).toBe(true);
  });

  it('selectUsedBytes counts encoded length + 1 terminator per macro', async () => {
    const { transport } = fakeTransport();
    await useMacroStore.getState().attach(transport);
    // 8 empty macros = 8 zero terminators
    expect(selectUsedBytes(useMacroStore.getState())).toBe(8);
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    // +3 bytes for the tap
    expect(selectUsedBytes(useMacroStore.getState())).toBe(11);
  });
});

describe('save', () => {
  it('refuses when locked', async () => {
    const { fake, transport } = fakeTransport();
    fake.locked = true;
    await useMacroStore.getState().attach(transport);
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    await useMacroStore.getState().save();
    expect(useMacroStore.getState().phase.kind).toBe('error');
    expect(fake.writes).toEqual([]);
  });

  it('writes the encoded buffer in 28-byte chunks and updates baseline', async () => {
    const { fake, transport } = fakeTransport();
    await useMacroStore.getState().attach(transport);
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    await useMacroStore.getState().save();
    expect(useMacroStore.getState().phase.kind).toBe('ready');
    // Buffer size is 64 → 3 chunks (28 + 28 + 8).
    expect(fake.writes.map((w) => w.offset)).toEqual([0, 28, 56]);
    // Roundtrip: decoding the on-device buffer should recover the
    // updated first macro.
    const decoded = decodeBuffer(fake.buffer, fake.count);
    expect(decoded[0]).toEqual([{ kind: 'tap', keycode: 0x04 }]);
    // Baseline should now match local.
    expect(selectIsDirty(useMacroStore.getState())).toBe(false);
  });

  it('overflow surfaces as a clear error without touching the device', async () => {
    const { fake, transport } = fakeTransport();
    await useMacroStore.getState().attach(transport);
    // Stuff a single macro past the 64-byte capacity.
    const seq: MacroSequence = [];
    for (let i = 0; i < 30; i++) seq.push({ kind: 'tap', keycode: 0x04 });
    useMacroStore.getState().setMacro(0, seq);
    await useMacroStore.getState().save();
    const phase = useMacroStore.getState().phase;
    expect(phase.kind).toBe('error');
    if (phase.kind === 'error') expect(phase.message).toMatch(/超え/);
    expect(fake.writes).toEqual([]);
  });

  it('mid-flight failure surfaces an explicit "may be inconsistent" message', async () => {
    const { fake, transport } = fakeTransport();
    await useMacroStore.getState().attach(transport);
    useMacroStore.getState().addAction(0, { kind: 'tap', keycode: 0x04 });
    fake.failOnChunk = 1; // succeed chunk 1, fail chunk 2
    await useMacroStore.getState().save();
    const phase = useMacroStore.getState().phase;
    expect(phase.kind).toBe('error');
    if (phase.kind === 'error') expect(phase.message).toMatch(/不整合/);
  });
});
