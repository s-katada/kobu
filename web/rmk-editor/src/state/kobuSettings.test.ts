import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KOBU_VALUES, valueBytes } from '../protocol/customValue';
import { intoVialPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { useKobuSettingsStore } from './kobuSettings';

vi.useFakeTimers();

class FakeTransport {
  // map id → stored value
  stored = new Map<number, number>();
  writes: Array<{ id: number; value: number }> = [];

  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    const reply = new Uint8Array(new ArrayBuffer(32));
    const cmd = packet[0];
    const channel = packet[1];
    const id = packet[2] ?? 0;
    if (channel !== 0xc0) return intoVialPacket(reply);

    const def = KOBU_VALUES.find((v) => v.id === id);

    if (cmd === 0x08 && def) {
      // CustomGetValue
      const stored = this.stored.get(id);
      if (stored !== undefined) {
        if (valueBytes(def.type) === 2) {
          reply[3] = (stored >> 8) & 0xff;
          reply[4] = stored & 0xff;
        } else {
          reply[3] = stored;
        }
      } else {
        // Match RMK 0.8 stub behaviour: leaves the buffer untouched.
        // The store should detect "all defaults" and surface
        // firmwareSupportsKobuChannel=false.
      }
    } else if (cmd === 0x07 && def) {
      // CustomSetValue
      let value: number;
      if (valueBytes(def.type) === 2) {
        value = ((packet[3] ?? 0) << 8) | (packet[4] ?? 0);
      } else {
        value = packet[3] ?? 0;
      }
      this.writes.push({ id, value });
      this.stored.set(id, value);
    }
    return intoVialPacket(reply);
  }
}

function fakeTransport(): { fake: FakeTransport; transport: WebHidTransport } {
  const fake = new FakeTransport();
  return { fake, transport: fake as unknown as WebHidTransport };
}

beforeEach(() => {
  useKobuSettingsStore.getState().detach();
});

describe('attach', () => {
  it('reads every slot and reflects them in baseline + local', async () => {
    const { fake, transport } = fakeTransport();
    fake.stored.set(0x01, 1600); // trackball_cpi
    fake.stored.set(0x02, 25); // scroll_throttle_ms
    fake.stored.set(0x03, 1); // scroll_invert_x = true
    await useKobuSettingsStore.getState().attach(transport);
    const s = useKobuSettingsStore.getState();
    expect(s.phase.kind).toBe('ready');
    expect(s.local.trackball_cpi).toBe(1600);
    expect(s.local.scroll_throttle_ms).toBe(25);
    expect(s.local.scroll_invert_x).toBe(1);
  });
});

describe('setValue', () => {
  beforeEach(async () => {
    const { transport } = fakeTransport();
    await useKobuSettingsStore.getState().attach(transport);
  });

  it('updates local immediately', () => {
    useKobuSettingsStore.getState().setValue('trackball_cpi', 1600);
    expect(useKobuSettingsStore.getState().local.trackball_cpi).toBe(1600);
  });

  it('clamps to the def range before storing locally', () => {
    useKobuSettingsStore.getState().setValue('trackball_cpi', 99999);
    expect(useKobuSettingsStore.getState().local.trackball_cpi).toBe(3200);
  });

  it('debounces wire writes (one round-trip per slot after settle)', async () => {
    const { fake, transport } = fakeTransport();
    await useKobuSettingsStore.getState().attach(transport);
    const store = useKobuSettingsStore.getState();
    store.setValue('trackball_cpi', 1400);
    store.setValue('trackball_cpi', 1500);
    store.setValue('trackball_cpi', 1600);
    expect(fake.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.writes).toEqual([{ id: 0x01, value: 1600 }]);
  });

  it('reset commits the default through the same debounce path', async () => {
    const { fake, transport } = fakeTransport();
    fake.stored.set(0x01, 1600);
    await useKobuSettingsStore.getState().attach(transport);
    useKobuSettingsStore.getState().resetCategory(['trackball_cpi']);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.writes).toEqual([{ id: 0x01, value: 1000 }]);
  });
});
