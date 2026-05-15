import { describe, expect, it, vi } from 'vitest';
import { intoVialPacket, VIAL_PACKET_SIZE } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { parseLayerCount, ViaCommand } from './commands';
import {
  customSave,
  decodeKeymap,
  eepromReset,
  fetchKeymap,
  fetchLayerCount,
  GET_BUFFER_CHUNK,
  resetKeymap,
  setKeycode,
} from './keymap';

function makeReply(bytes: number[]): ReturnType<typeof intoVialPacket> {
  const buf = new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE));
  bytes.forEach((b, i) => {
    buf[i] = b;
  });
  return intoVialPacket(buf);
}

function makeFakeTransport(scripted: Uint8Array[]) {
  let idx = 0;
  const sendAndReceive = vi.fn(async () => {
    const reply = scripted[idx++];
    if (!reply) throw new Error('Test transport ran out of scripted replies');
    return intoVialPacket(reply as Uint8Array<ArrayBuffer>);
  });
  return { sendAndReceive } as unknown as WebHidTransport;
}

describe('parseLayerCount', () => {
  it('returns the layer-count byte at offset 1', () => {
    expect(parseLayerCount(makeReply([ViaCommand.DynamicKeymapGetLayerCount, 0x04]))).toBe(4);
  });
});

describe('decodeKeymap', () => {
  it('converts the flat byte buffer into the 3-D structure', () => {
    const dim = { layers: 1, rows: 2, cols: 3 };
    // Three keycodes per row, 2 rows: 0x0001, 0x0002, 0x0003 / 0x0004, 0x0005, 0x0006
    const flat = new Uint8Array([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6]);
    const out = decodeKeymap(flat, dim);
    expect(out).toEqual([
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
    ]);
  });

  it('reads big-endian for each keycode', () => {
    const flat = new Uint8Array([0x08, 0x40]); // User0
    expect(decodeKeymap(flat, { layers: 1, rows: 1, cols: 1 })).toEqual([[[0x0840]]]);
  });
});

describe('fetchLayerCount', () => {
  it('returns the layer count byte', async () => {
    const t = makeFakeTransport([
      new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE)).fill(0).map((_, i) => (i === 1 ? 4 : 0)),
    ]);
    expect(await fetchLayerCount(t)).toBe(4);
  });
});

describe('fetchKeymap', () => {
  it('chunks GetBuffer requests and reassembles the keymap', async () => {
    const dim = { layers: 1, rows: 1, cols: 2 };
    // total = 4 bytes -> one GetBuffer round trip is enough.
    const reply = new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE));
    reply[0] = ViaCommand.DynamicKeymapGetBuffer;
    reply[1] = 0; // offset hi
    reply[2] = 0; // offset lo
    reply[3] = 4; // size = 4 bytes
    reply[4] = 0x00;
    reply[5] = 0x14; // 'Q'
    reply[6] = 0x00;
    reply[7] = 0x1a; // 'W'

    const t = makeFakeTransport([reply]);
    const map = await fetchKeymap(t, dim);
    expect(map).toEqual([[[0x0014, 0x001a]]]);
  });

  it('walks every chunk for a larger keymap', async () => {
    // 28 byte chunks; kobu's 320-byte keymap fits in 12 chunks.
    const dim = { layers: 4, rows: 4, cols: 10 };
    const total = dim.layers * dim.rows * dim.cols * 2;
    const chunks = Math.ceil(total / GET_BUFFER_CHUNK);

    const scripted = Array.from({ length: chunks }, (_, idx) => {
      const remaining = total - idx * GET_BUFFER_CHUNK;
      const size = Math.min(GET_BUFFER_CHUNK, remaining);
      const reply = new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE));
      reply[3] = size;
      // Fill the payload with the offset value so we can verify ordering.
      for (let i = 0; i < size; i++) reply[4 + i] = (idx * GET_BUFFER_CHUNK + i) & 0xff;
      return reply;
    });

    const t = makeFakeTransport(scripted);
    const map = await fetchKeymap(t, dim);
    // Each keycode = (hi << 8) | lo. First two payload bytes were 0, 1 → 0x0001.
    expect(map[0]?.[0]?.[0]).toBe(0x0001);
    expect(map[0]?.[0]?.[1]).toBe(0x0203);
    expect(chunks).toBe(12);
  });
});

describe('setKeycode', () => {
  it('encodes the Set-KeyCode packet correctly', async () => {
    const sendAndReceive = vi.fn(async (packet: Uint8Array) =>
      intoVialPacket(new Uint8Array(packet.buffer as ArrayBuffer) as Uint8Array<ArrayBuffer>),
    );
    const t = { sendAndReceive } as unknown as WebHidTransport;
    await setKeycode(t, 1, 2, 3, 0x0014);

    const call = sendAndReceive.mock.calls[0];
    expect(call).toBeDefined();
    const sent = (call as unknown as [Uint8Array])[0];
    expect(sent[0]).toBe(ViaCommand.DynamicKeymapSetKeyCode);
    expect(sent[1]).toBe(1);
    expect(sent[2]).toBe(2);
    expect(sent[3]).toBe(3);
    expect(sent[4]).toBe(0x00);
    expect(sent[5]).toBe(0x14);
  });
});

describe('resetKeymap', () => {
  it('sends the DynamicKeymapReset command', async () => {
    const sendAndReceive = vi.fn(async () =>
      intoVialPacket(new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE))),
    );
    const t = { sendAndReceive } as unknown as WebHidTransport;
    await resetKeymap(t);
    const call = sendAndReceive.mock.calls[0];
    expect(call).toBeDefined();
    const sent = (call as unknown as [Uint8Array])[0];
    expect(sent[0]).toBe(ViaCommand.DynamicKeymapReset);
  });
});

describe('eepromReset', () => {
  it('sends the EepromReset command (destructive)', async () => {
    const sendAndReceive = vi.fn(async () =>
      intoVialPacket(new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE))),
    );
    const t = { sendAndReceive } as unknown as WebHidTransport;
    await eepromReset(t);
    const call = sendAndReceive.mock.calls[0];
    expect(call).toBeDefined();
    const sent = (call as unknown as [Uint8Array])[0];
    expect(sent[0]).toBe(ViaCommand.EepromReset);
  });
});

describe('customSave', () => {
  it('sends the CustomSave command (no-op on kobu)', async () => {
    const sendAndReceive = vi.fn(async () =>
      intoVialPacket(new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE))),
    );
    const t = { sendAndReceive } as unknown as WebHidTransport;
    await customSave(t);
    const call = sendAndReceive.mock.calls[0];
    expect(call).toBeDefined();
    const sent = (call as unknown as [Uint8Array])[0];
    expect(sent[0]).toBe(ViaCommand.CustomSave);
  });
});
