import { describe, expect, it, vi } from 'vitest';
import { emptyPacket, intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import {
  buildMacroGetBuffer,
  buildMacroSetBuffer,
  parseMacroBufferSize,
  parseMacroCount,
} from './commands';
import {
  decodeBuffer,
  decodeSequence,
  encodeAction,
  encodeBuffer,
  encodeSequence,
  fetchMacroBuffer,
  fetchMacroBufferSize,
  fetchMacroCount,
  type MacroAction,
  writeMacroBuffer,
} from './macros';

describe('encodeAction', () => {
  it('tap is 0x01 0x01 KC', () => {
    expect(Array.from(encodeAction({ kind: 'tap', keycode: 0x04 }))).toEqual([0x01, 0x01, 0x04]);
  });
  it('down is 0x01 0x02 KC', () => {
    expect(Array.from(encodeAction({ kind: 'down', keycode: 0xe1 }))).toEqual([0x01, 0x02, 0xe1]);
  });
  it('up is 0x01 0x03 KC', () => {
    expect(Array.from(encodeAction({ kind: 'up', keycode: 0xe1 }))).toEqual([0x01, 0x03, 0xe1]);
  });
  it('delay encodes (ms % 255 + 1, ms / 255 + 1) to keep bytes non-zero', () => {
    expect(Array.from(encodeAction({ kind: 'delay', ms: 0 }))).toEqual([0x01, 0x04, 1, 1]);
    expect(Array.from(encodeAction({ kind: 'delay', ms: 30 }))).toEqual([0x01, 0x04, 31, 1]);
    expect(Array.from(encodeAction({ kind: 'delay', ms: 254 }))).toEqual([0x01, 0x04, 255, 1]);
    expect(Array.from(encodeAction({ kind: 'delay', ms: 255 }))).toEqual([0x01, 0x04, 1, 2]);
    expect(Array.from(encodeAction({ kind: 'delay', ms: 1000 }))).toEqual([
      0x01,
      0x04,
      (1000 % 255) + 1,
      Math.floor(1000 / 255) + 1,
    ]);
  });
  it('text emits a single literal byte', () => {
    expect(Array.from(encodeAction({ kind: 'text', byte: 0x48 }))).toEqual([0x48]);
  });
  it('unsupported passes raw bytes through verbatim', () => {
    expect(
      Array.from(encodeAction({ kind: 'unsupported', bytes: [0x01, 0x05, 0x12, 0x34] })),
    ).toEqual([0x01, 0x05, 0x12, 0x34]);
  });
});

describe('encodeSequence', () => {
  it('concatenates action bytes without a trailing terminator', () => {
    const seq: MacroAction[] = [
      { kind: 'down', keycode: 0xe1 },
      { kind: 'tap', keycode: 0x14 }, // Q
      { kind: 'up', keycode: 0xe1 },
    ];
    expect(Array.from(encodeSequence(seq))).toEqual([
      0x01,
      0x02,
      0xe1, // down LShift
      0x01,
      0x01,
      0x14, // tap Q
      0x01,
      0x03,
      0xe1, // up LShift
    ]);
  });
});

describe('encodeBuffer', () => {
  it('separates non-empty sequences with 0x00 and pads to size', () => {
    const sequences: MacroAction[][] = [
      [{ kind: 'tap', keycode: 0x04 }],
      [{ kind: 'tap', keycode: 0x05 }],
    ];
    const buf = encodeBuffer(sequences, 16);
    expect(Array.from(buf)).toEqual([
      0x01,
      0x01,
      0x04,
      0x00, // first macro + terminator
      0x01,
      0x01,
      0x05,
      0x00, // second macro + terminator
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // padding
    ]);
  });
  it('empty sequences contribute just a 0x00', () => {
    const buf = encodeBuffer([[], []], 4);
    expect(Array.from(buf)).toEqual([0x00, 0x00, 0x00, 0x00]);
  });
  it('throws when the encoded data would not fit', () => {
    expect(() => encodeBuffer([[{ kind: 'tap', keycode: 1 }]], 3)).toThrow(/overflow/);
  });
});

describe('decodeSequence', () => {
  it('reads tap/press/release until 0x00', () => {
    const bytes = new Uint8Array([
      0x01,
      0x02,
      0xe1, // down LShift
      0x01,
      0x01,
      0x04, // tap A
      0x01,
      0x03,
      0xe1, // up LShift
      0x00,
    ]);
    const { actions, nextStart } = decodeSequence(bytes, 0);
    expect(actions).toEqual([
      { kind: 'down', keycode: 0xe1 },
      { kind: 'tap', keycode: 0x04 },
      { kind: 'up', keycode: 0xe1 },
    ]);
    expect(nextStart).toBe(10);
  });
  it('decodes delay using the (b1-1)+(b2-1)*255 rule', () => {
    const bytes = new Uint8Array([0x01, 0x04, 31, 1, 0x00]);
    expect(decodeSequence(bytes, 0).actions).toEqual([{ kind: 'delay', ms: 30 }]);
  });
  it('clamps delay bytes to >= 1 before subtracting', () => {
    // A buffer where firmware-side bytes happen to be 0 should still
    // decode without going negative.
    const bytes = new Uint8Array([0x01, 0x04, 0, 0, 0x00]);
    expect(decodeSequence(bytes, 0).actions).toEqual([{ kind: 'delay', ms: 0 }]);
  });
  it('round-trips encode→decode for tap/down/up/delay/text', () => {
    const seq: MacroAction[] = [
      { kind: 'down', keycode: 0xe1 },
      { kind: 'tap', keycode: 0x14 },
      { kind: 'up', keycode: 0xe1 },
      { kind: 'delay', ms: 1234 },
      { kind: 'text', byte: 0x48 },
    ];
    const buf = encodeBuffer([seq], 64);
    const [decoded] = decodeBuffer(buf, 1);
    expect(decoded).toEqual(seq);
  });
  it('preserves VIAL_MACRO_EXT bytes as unsupported actions', () => {
    const bytes = new Uint8Array([0x01, 0x05, 0xab, 0xcd, 0x00]);
    expect(decodeSequence(bytes, 0).actions).toEqual([
      { kind: 'unsupported', bytes: [0x01, 0x05, 0xab, 0xcd] },
    ]);
  });
});

describe('decodeBuffer', () => {
  it('splits a buffer into the requested number of macros', () => {
    const bytes = new Uint8Array([
      0x01,
      0x01,
      0x04,
      0x00, // tap A; macro 0
      0x48,
      0x00, // text 'H'; macro 1
      0x00, // macro 2 = empty
      0x00,
      0x00,
      0x00,
      0x00, // padding
    ]);
    const macros = decodeBuffer(bytes, 3);
    expect(macros).toEqual([[{ kind: 'tap', keycode: 0x04 }], [{ kind: 'text', byte: 0x48 }], []]);
  });
  it('returns empty macros for slots past the last terminator', () => {
    const bytes = new Uint8Array(8);
    bytes.set([0x01, 0x01, 0x04, 0x00], 0);
    const macros = decodeBuffer(bytes, 4);
    expect(macros.length).toBe(4);
    expect(macros[0]).toEqual([{ kind: 'tap', keycode: 0x04 }]);
    expect(macros[1]).toEqual([]);
    expect(macros[2]).toEqual([]);
    expect(macros[3]).toEqual([]);
  });
});

describe('parsers', () => {
  it('parseMacroCount reads byte 1', () => {
    const reply = new Uint8Array(new ArrayBuffer(32));
    reply[1] = 32;
    expect(parseMacroCount(intoVialPacket(reply))).toBe(32);
  });
  it('parseMacroBufferSize reads BE u16 at 1..3', () => {
    const reply = new Uint8Array(new ArrayBuffer(32));
    reply[1] = 0x01;
    reply[2] = 0x00;
    expect(parseMacroBufferSize(intoVialPacket(reply))).toBe(256);
  });
});

describe('builders', () => {
  it('buildMacroGetBuffer writes BE offset and size', () => {
    const p = buildMacroGetBuffer(0x0123, 28);
    expect(p[0]).toBe(0x0e);
    expect(p[1]).toBe(0x01);
    expect(p[2]).toBe(0x23);
    expect(p[3]).toBe(28);
  });
  it('buildMacroSetBuffer copies payload after the 4-byte header', () => {
    const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const p = buildMacroSetBuffer(0x0010, data);
    expect(p[0]).toBe(0x0f);
    expect(p[1]).toBe(0x00);
    expect(p[2]).toBe(0x10);
    expect(p[3]).toBe(3);
    expect(p[4]).toBe(0xaa);
    expect(p[5]).toBe(0xbb);
    expect(p[6]).toBe(0xcc);
  });
  it('buildMacroSetBuffer rejects chunks > 28 bytes', () => {
    expect(() => buildMacroSetBuffer(0, new Uint8Array(29))).toThrow(/too large/);
  });
});

describe('transport helpers', () => {
  function freshReply(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(new ArrayBuffer(32));
  }

  function mockTransport(
    handler: (packet: VialPacket) => Uint8Array<ArrayBuffer>,
  ): WebHidTransport {
    return {
      sendAndReceive: vi.fn(async (packet: VialPacket) => intoVialPacket(handler(packet))),
    } as unknown as WebHidTransport;
  }

  it('fetchMacroCount queries 0x0C and parses byte 1', async () => {
    const t = mockTransport(() => {
      const r = freshReply();
      r[1] = 32;
      return r;
    });
    expect(await fetchMacroCount(t)).toBe(32);
  });

  it('fetchMacroBufferSize queries 0x0D and parses BE u16', async () => {
    const t = mockTransport(() => {
      const r = freshReply();
      r[1] = 0x01;
      r[2] = 0x00;
      return r;
    });
    expect(await fetchMacroBufferSize(t)).toBe(256);
  });

  it('fetchMacroBuffer issues ceil(size/28) chunks and concatenates payloads', async () => {
    // Build a deterministic firmware buffer where each byte == its
    // offset so we can verify chunk reassembly.
    const total = 256;
    const firmwareBuf = new Uint8Array(total);
    for (let i = 0; i < total; i++) firmwareBuf[i] = i & 0xff;
    const t = mockTransport((packet) => {
      const offset = ((packet[1] ?? 0) << 8) | (packet[2] ?? 0);
      const size = packet[3] ?? 0;
      const r = freshReply();
      r[0] = packet[0] ?? 0;
      r[1] = packet[1] ?? 0;
      r[2] = packet[2] ?? 0;
      r[3] = size;
      r.set(firmwareBuf.subarray(offset, offset + size), 4);
      return r;
    });
    const got = await fetchMacroBuffer(t, total);
    expect(Array.from(got)).toEqual(Array.from(firmwareBuf));
    expect(t.sendAndReceive).toHaveBeenCalledTimes(Math.ceil(total / 28));
  });

  it('writeMacroBuffer sends 28-byte chunks at sequential offsets and reports progress', async () => {
    const calls: Array<{ offset: number; size: number }> = [];
    const t = mockTransport((packet) => {
      const offset = ((packet[1] ?? 0) << 8) | (packet[2] ?? 0);
      const size = packet[3] ?? 0;
      calls.push({ offset, size });
      return emptyPacket();
    });
    const progress: number[] = [];
    const buf = new Uint8Array(60);
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    await writeMacroBuffer(t, buf, (written) => progress.push(written));
    expect(calls).toEqual([
      { offset: 0, size: 28 },
      { offset: 28, size: 28 },
      { offset: 56, size: 4 },
    ]);
    expect(progress).toEqual([28, 56, 60]);
  });
});
