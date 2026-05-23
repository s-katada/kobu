import { describe, expect, it, vi } from 'vitest';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { buildMorseGet, buildMorseSet, isMorseEmpty, parseMorseGet, VialDynamic } from './commands';
import { emptyMorse, entriesEqual, fetchAllMorses, fetchMorse, setMorse } from './morses';

describe('builders', () => {
  it('buildMorseGet writes [0xFE, 0x0D, 0x01, idx]', () => {
    const p = buildMorseGet(5);
    expect(p[0]).toBe(0xfe);
    expect(p[1]).toBe(0x0d);
    expect(p[2]).toBe(VialDynamic.MorseGet);
    expect(p[3]).toBe(5);
  });

  it('buildMorseSet writes 4 keycodes + tap term, all LE u16', () => {
    const p = buildMorseSet(2, {
      tap: 0x000d,
      hold: 0x00e0,
      doubleTap: 0x0029,
      holdAfterTap: 0,
      tapTermMs: 200,
    });
    expect(p[0]).toBe(0xfe);
    expect(p[1]).toBe(0x0d);
    expect(p[2]).toBe(VialDynamic.MorseSet);
    expect(p[3]).toBe(2);
    expect(p[4]).toBe(0x0d);
    expect(p[5]).toBe(0x00);
    expect(p[6]).toBe(0xe0);
    expect(p[7]).toBe(0x00);
    expect(p[8]).toBe(0x29);
    expect(p[9]).toBe(0x00);
    expect(p[10]).toBe(0);
    expect(p[11]).toBe(0);
    expect(p[12]).toBe(200 & 0xff);
    expect(p[13]).toBe((200 >> 8) & 0xff);
  });
});

describe('parsers', () => {
  it('parseMorseGet reads 4 keycodes + tap term as LE u16', () => {
    const reply = new Uint8Array(new ArrayBuffer(32));
    reply[0] = 0; // return code
    reply[1] = 0x0d; // tap = J
    reply[3] = 0xe0; // hold = LCtrl
    reply[5] = 0x29; // double tap = Esc
    reply[9] = 0xc8; // 200ms (low byte)
    expect(parseMorseGet(intoVialPacket(reply))).toEqual({
      tap: 0x0d,
      hold: 0xe0,
      doubleTap: 0x29,
      holdAfterTap: 0,
      tapTermMs: 200,
    });
  });

  it('isMorseEmpty true when every keycode slot is zero', () => {
    expect(isMorseEmpty({ tap: 0, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 })).toBe(
      true,
    );
    expect(isMorseEmpty({ tap: 1, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 })).toBe(
      false,
    );
  });
});

describe('helpers', () => {
  it('entriesEqual matches across every field', () => {
    expect(entriesEqual(emptyMorse(), emptyMorse())).toBe(true);
    expect(
      entriesEqual(
        { tap: 1, hold: 2, doubleTap: 3, holdAfterTap: 4, tapTermMs: 200 },
        { tap: 1, hold: 2, doubleTap: 3, holdAfterTap: 4, tapTermMs: 200 },
      ),
    ).toBe(true);
    expect(
      entriesEqual(
        { tap: 1, hold: 2, doubleTap: 3, holdAfterTap: 4, tapTermMs: 200 },
        { tap: 1, hold: 2, doubleTap: 3, holdAfterTap: 4, tapTermMs: 250 },
      ),
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

  it('fetchMorse parses the reply at index 0', async () => {
    const t = mockTransport((packet) => {
      expect(packet[2]).toBe(VialDynamic.MorseGet);
      expect(packet[3]).toBe(3);
      const r = new Uint8Array(new ArrayBuffer(32));
      r[1] = 0x0d;
      return r;
    });
    const m = await fetchMorse(t, 3);
    expect(m.tap).toBe(0x0d);
  });

  it('fetchAllMorses iterates from 0..count', async () => {
    const seen: number[] = [];
    const t = mockTransport((packet) => {
      seen.push(packet[3] ?? -1);
      return new Uint8Array(new ArrayBuffer(32));
    });
    await fetchAllMorses(t, 3);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('setMorse sends MorseSet with the entry payload', async () => {
    let captured: VialPacket | null = null;
    const t = mockTransport((packet) => {
      captured = packet;
      return new Uint8Array(new ArrayBuffer(32));
    });
    await setMorse(t, 0, {
      tap: 0x0d,
      hold: 0xe0,
      doubleTap: 0,
      holdAfterTap: 0,
      tapTermMs: 200,
    });
    const sent = captured as VialPacket | null;
    expect(sent).not.toBeNull();
    if (sent) {
      expect(sent[2]).toBe(VialDynamic.MorseSet);
      expect(sent[4]).toBe(0x0d);
      expect(sent[6]).toBe(0xe0);
      expect(sent[12]).toBe(200);
    }
  });
});
