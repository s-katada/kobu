import { beforeEach, describe, expect, it } from 'vitest';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import {
  MORSE_PRESETS,
  selectDirtyMask,
  selectIsDirty,
  selectWarnings,
  useMorseStore,
} from './morses';

class FakeTransport {
  morseCount = 3;
  comboCount = 16;
  stored: Array<{
    tap: number;
    hold: number;
    doubleTap: number;
    holdAfterTap: number;
    tapTermMs: number;
  }> = [];
  locked = false;
  writes: Array<{
    idx: number;
    entry: {
      tap: number;
      hold: number;
      doubleTap: number;
      holdAfterTap: number;
      tapTermMs: number;
    };
  }> = [];

  constructor() {
    for (let i = 0; i < this.morseCount; i++) {
      this.stored.push({ tap: 0, hold: 0, doubleTap: 0, holdAfterTap: 0, tapTermMs: 200 });
    }
  }

  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    const reply = new Uint8Array(new ArrayBuffer(32));
    const cmd = packet[0];
    const sub = packet[1];
    const sub2 = packet[2];

    if (cmd === 0xfe && sub === 0x0d && sub2 === 0x00) {
      reply[0] = this.morseCount;
      reply[1] = this.comboCount;
      reply[2] = 0;
      reply[31] = 1;
    } else if (cmd === 0xfe && sub === 0x0d && sub2 === 0x01) {
      const idx = packet[3] ?? 0;
      const entry = this.stored[idx];
      if (entry) {
        reply[1] = entry.tap & 0xff;
        reply[2] = (entry.tap >> 8) & 0xff;
        reply[3] = entry.hold & 0xff;
        reply[4] = (entry.hold >> 8) & 0xff;
        reply[5] = entry.doubleTap & 0xff;
        reply[6] = (entry.doubleTap >> 8) & 0xff;
        reply[7] = entry.holdAfterTap & 0xff;
        reply[8] = (entry.holdAfterTap >> 8) & 0xff;
        reply[9] = entry.tapTermMs & 0xff;
        reply[10] = (entry.tapTermMs >> 8) & 0xff;
      }
    } else if (cmd === 0xfe && sub === 0x0d && sub2 === 0x02) {
      const idx = packet[3] ?? 0;
      const entry = {
        tap: (packet[4] ?? 0) | ((packet[5] ?? 0) << 8),
        hold: (packet[6] ?? 0) | ((packet[7] ?? 0) << 8),
        doubleTap: (packet[8] ?? 0) | ((packet[9] ?? 0) << 8),
        holdAfterTap: (packet[10] ?? 0) | ((packet[11] ?? 0) << 8),
        tapTermMs: (packet[12] ?? 0) | ((packet[13] ?? 0) << 8),
      };
      this.writes.push({ idx, entry });
      this.stored[idx] = entry;
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
  useMorseStore.getState().detach();
});

describe('attach', () => {
  it('reads tap-dance count and fetches every entry', async () => {
    const { fake, transport } = fakeTransport();
    fake.stored[0] = { tap: 0x0d, hold: 0x00e0, doubleTap: 0x29, holdAfterTap: 0, tapTermMs: 200 };
    await useMorseStore.getState().attach(transport);
    const s = useMorseStore.getState();
    expect(s.phase.kind).toBe('ready');
    expect(s.count).toBe(3);
    expect(s.local[0]).toEqual({
      tap: 0x0d,
      hold: 0xe0,
      doubleTap: 0x29,
      holdAfterTap: 0,
      tapTermMs: 200,
    });
  });
});

describe('editing', () => {
  beforeEach(async () => {
    const { transport } = fakeTransport();
    await useMorseStore.getState().attach(transport);
  });

  it('setTap updates only the tap field', () => {
    useMorseStore.getState().setTap(0, 0x0d);
    expect(useMorseStore.getState().local[0]?.tap).toBe(0x0d);
    expect(useMorseStore.getState().local[0]?.hold).toBe(0);
  });

  it('setTapTerm updates the tap-term', () => {
    useMorseStore.getState().setTapTerm(0, 300);
    expect(useMorseStore.getState().local[0]?.tapTermMs).toBe(300);
  });

  it('clearEntry zeroes every field', () => {
    useMorseStore.getState().setTap(0, 0x0d);
    useMorseStore.getState().clearEntry(0);
    expect(useMorseStore.getState().local[0]?.tap).toBe(0);
  });

  it('resetEntry restores from baseline', () => {
    useMorseStore.getState().setTap(0, 0x99);
    useMorseStore.getState().resetEntry(0);
    expect(useMorseStore.getState().local[0]?.tap).toBe(0);
  });

  it('applyPreset runs the builder', () => {
    const preset = MORSE_PRESETS[0];
    if (!preset) throw new Error('expected preset 0 to exist');
    useMorseStore.getState().applyPreset(0, preset);
    // tap→Esc / hold→Ctrl preset sets hold = LCtrl
    expect(useMorseStore.getState().local[0]?.hold).toBe(0x00e0);
    expect(useMorseStore.getState().local[0]?.doubleTap).toBe(0x0029);
  });
});

describe('selectors', () => {
  beforeEach(async () => {
    const { transport } = fakeTransport();
    await useMorseStore.getState().attach(transport);
  });

  it('selectIsDirty flips on any change', () => {
    expect(selectIsDirty(useMorseStore.getState())).toBe(false);
    useMorseStore.getState().setTap(0, 0x0d);
    expect(selectIsDirty(useMorseStore.getState())).toBe(true);
  });

  it('selectDirtyMask reports per-entry dirty flags', () => {
    useMorseStore.getState().setTap(2, 0x0d);
    const mask = selectDirtyMask(useMorseStore.getState());
    expect(mask[0]).toBe(false);
    expect(mask[2]).toBe(true);
  });

  it('selectWarnings flags out-of-range tap term', () => {
    useMorseStore.getState().setTapTerm(0, 30); // < 50ms
    const w = selectWarnings(useMorseStore.getState());
    expect(w[0]).toContain('out-of-range');
  });

  it('selectWarnings flags no-op (every keycode zero)', () => {
    // Fresh entries are all-zero by default, so the warning fires.
    const w = selectWarnings(useMorseStore.getState());
    expect(w[0]).toContain('no-op');
  });

  it('selectWarnings drops the no-op warning once any keycode is set', () => {
    useMorseStore.getState().setTap(0, 0x0d);
    const w = selectWarnings(useMorseStore.getState());
    expect(w[0]).not.toContain('no-op');
  });
});

describe('save', () => {
  it('refuses when locked', async () => {
    const { fake, transport } = fakeTransport();
    fake.locked = true;
    await useMorseStore.getState().attach(transport);
    useMorseStore.getState().setTap(0, 0x0d);
    await useMorseStore.getState().save();
    expect(useMorseStore.getState().phase.kind).toBe('error');
    expect(fake.writes).toEqual([]);
  });

  it('writes dirty entries and updates baseline', async () => {
    const { fake, transport } = fakeTransport();
    await useMorseStore.getState().attach(transport);
    useMorseStore.getState().setTap(1, 0x0d);
    useMorseStore.getState().setTap(2, 0x0e);
    await useMorseStore.getState().save();
    expect(useMorseStore.getState().phase.kind).toBe('ready');
    expect(fake.writes.map((w) => w.idx)).toEqual([1, 2]);
    expect(selectIsDirty(useMorseStore.getState())).toBe(false);
  });
});
