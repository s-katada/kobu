import { describe, expect, it, vi } from 'vitest';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import {
  emptyCombo,
  entriesEqual,
  fetchAllCombos,
  fetchCombo,
  fetchDynamicEntryCounts,
  setCombo,
} from './combos';
import {
  buildComboGet,
  buildComboSet,
  buildGetNumberOfEntries,
  isComboEmpty,
  parseComboGet,
  parseNumberOfEntries,
  VialDynamic,
} from './commands';

describe('builders', () => {
  it('buildGetNumberOfEntries uses [0xFE, 0x0D, 0x00]', () => {
    const p = buildGetNumberOfEntries();
    expect(p[0]).toBe(0xfe);
    expect(p[1]).toBe(0x0d);
    expect(p[2]).toBe(VialDynamic.GetNumberOfEntries);
  });

  it('buildComboGet writes the index at byte 3', () => {
    const p = buildComboGet(7);
    expect(p[0]).toBe(0xfe);
    expect(p[1]).toBe(0x0d);
    expect(p[2]).toBe(VialDynamic.ComboGet);
    expect(p[3]).toBe(7);
  });

  it('buildComboSet writes inputs at 4..12 and output at 12..14, LE', () => {
    const p = buildComboSet(3, [0x0014, 0x0015, 0, 0], 0x0700);
    expect(p[0]).toBe(0xfe);
    expect(p[1]).toBe(0x0d);
    expect(p[2]).toBe(VialDynamic.ComboSet);
    expect(p[3]).toBe(3);
    expect(p[4]).toBe(0x14);
    expect(p[5]).toBe(0x00);
    expect(p[6]).toBe(0x15);
    expect(p[7]).toBe(0x00);
    // padded inputs
    expect(p[8]).toBe(0);
    expect(p[9]).toBe(0);
    expect(p[10]).toBe(0);
    expect(p[11]).toBe(0);
    // output
    expect(p[12]).toBe(0x00);
    expect(p[13]).toBe(0x07);
  });

  it('buildComboSet rejects more than 4 inputs', () => {
    expect(() => buildComboSet(0, [1, 2, 3, 4, 5], 6)).toThrow(/≤ 4/);
  });
});

describe('parsers', () => {
  it('parseNumberOfEntries reads tap/combo/keyoverride + caps word', () => {
    const reply = new Uint8Array(new ArrayBuffer(32));
    reply[0] = 8;
    reply[1] = 16;
    reply[2] = 0;
    reply[31] = 1;
    expect(parseNumberOfEntries(intoVialPacket(reply))).toEqual({
      tapDance: 8,
      combo: 16,
      keyOverride: 0,
      capsWordEnabled: true,
    });
  });

  it('parseComboGet reads 4 inputs + output as LE u16', () => {
    const reply = new Uint8Array(new ArrayBuffer(32));
    reply[0] = 0; // return code
    reply[1] = 0x14;
    reply[2] = 0x00; // input 0 = Q
    reply[3] = 0x1a;
    reply[4] = 0x00; // input 1 = W
    reply[5] = 0;
    reply[6] = 0; // input 2 empty
    reply[7] = 0;
    reply[8] = 0; // input 3 empty
    reply[9] = 0x29;
    reply[10] = 0x00; // output = Esc
    expect(parseComboGet(intoVialPacket(reply))).toEqual({
      inputs: [0x14, 0x1a, 0, 0],
      output: 0x29,
    });
  });

  it('isComboEmpty matches an all-zero entry', () => {
    expect(isComboEmpty({ inputs: [0, 0, 0, 0], output: 0 })).toBe(true);
    expect(isComboEmpty({ inputs: [0x14, 0, 0, 0], output: 0 })).toBe(false);
    expect(isComboEmpty({ inputs: [0, 0, 0, 0], output: 1 })).toBe(false);
  });
});

describe('helpers', () => {
  it('entriesEqual is shallow-deep', () => {
    expect(
      entriesEqual({ inputs: [1, 2, 3, 4], output: 5 }, { inputs: [1, 2, 3, 4], output: 5 }),
    ).toBe(true);
    expect(
      entriesEqual({ inputs: [1, 2, 3, 4], output: 5 }, { inputs: [1, 2, 3, 4], output: 6 }),
    ).toBe(false);
  });
});

describe('transport', () => {
  function mockTransport(
    handler: (packet: VialPacket) => Uint8Array<ArrayBuffer>,
  ): WebHidTransport {
    return {
      sendAndReceive: vi.fn(async (packet: VialPacket) => intoVialPacket(handler(packet))),
    } as unknown as WebHidTransport;
  }

  it('fetchDynamicEntryCounts uses 0xFE/0x0D/0x00 and parses counts', async () => {
    const t = mockTransport(() => {
      const r = new Uint8Array(new ArrayBuffer(32));
      r[0] = 8;
      r[1] = 16;
      r[2] = 0;
      return r;
    });
    const counts = await fetchDynamicEntryCounts(t);
    expect(counts.combo).toBe(16);
    expect(counts.tapDance).toBe(8);
  });

  it('fetchCombo issues one ComboGet for the index', async () => {
    const t = mockTransport((packet) => {
      expect(packet[2]).toBe(VialDynamic.ComboGet);
      expect(packet[3]).toBe(5);
      const r = new Uint8Array(new ArrayBuffer(32));
      r[1] = 0xaa;
      r[2] = 0xbb;
      return r;
    });
    const combo = await fetchCombo(t, 5);
    expect(combo.inputs[0]).toBe(0xbbaa);
  });

  it('fetchAllCombos calls ComboGet once per slot', async () => {
    const seen: number[] = [];
    const t = mockTransport((packet) => {
      seen.push(packet[3] ?? -1);
      return new Uint8Array(new ArrayBuffer(32));
    });
    await fetchAllCombos(t, 4);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('setCombo sends ComboSet with the right payload', async () => {
    let captured: VialPacket | null = null;
    const t = mockTransport((packet) => {
      captured = packet;
      return new Uint8Array(new ArrayBuffer(32));
    });
    await setCombo(t, 2, { inputs: [0x14, 0x1a, 0, 0], output: 0x29 });
    const sent = captured as VialPacket | null;
    expect(sent).not.toBeNull();
    if (sent) {
      expect(sent[2]).toBe(VialDynamic.ComboSet);
      expect(sent[3]).toBe(2);
      expect(sent[4]).toBe(0x14);
      expect(sent[12]).toBe(0x29);
    }
  });

  it('emptyCombo is a fresh zero entry every call', () => {
    const a = emptyCombo();
    const b = emptyCombo();
    expect(a).not.toBe(b);
    expect(a).toEqual({ inputs: [0, 0, 0, 0], output: 0 });
  });
});
