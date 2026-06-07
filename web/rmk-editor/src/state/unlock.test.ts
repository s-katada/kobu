import { afterEach, describe, expect, it, vi } from 'vitest';
import { intoVialPacket, VIAL_PACKET_SIZE } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { useUnlockStore } from './unlock';

function reply(bytes: number[]) {
  const buf = new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE));
  bytes.forEach((b, i) => {
    buf[i] = b;
  });
  return intoVialPacket(buf);
}

/** A transport that returns scripted replies in order. */
function transportFor(replies: number[][]) {
  let idx = 0;
  const sendAndReceive = vi.fn(async () => {
    const r = replies[idx++];
    if (!r) throw new Error('out of replies');
    return reply(r);
  });
  return { transport: { sendAndReceive } as unknown as WebHidTransport, sendAndReceive };
}

const LOCKED = [1, 0, 0, 0, 0, 9, 0xff, 0xff]; // locked, chord [[0,0],[0,9]]
const UNLOCKED = [0, 0, 0xff, 0xff];
const POLL_UNLOCKED = [0, 0, 0]; // locked=0 → unlock done

afterEach(() => {
  useUnlockStore.getState().detach();
});

describe('useUnlockStore', () => {
  it('attach refreshes status and exposes the chord when locked', async () => {
    const { transport } = transportFor([LOCKED]);
    await useUnlockStore.getState().attach(transport);
    const s = useUnlockStore.getState();
    expect(s.status).toBe('locked');
    expect(s.chord).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 9 },
    ]);
  });

  it('attach reports unlocked when the firmware is already open', async () => {
    const { transport } = transportFor([UNLOCKED]);
    await useUnlockStore.getState().attach(transport);
    expect(useUnlockStore.getState().status).toBe('unlocked');
  });

  it('beginUnlock drives the chord hold to success and re-reads status', async () => {
    // attach→GetUnlockStatus(locked); begin→UnlockStart; poll→unlocked; refresh→GetUnlockStatus(unlocked)
    const { transport, sendAndReceive } = transportFor([LOCKED, [0, 0], POLL_UNLOCKED, UNLOCKED]);
    const store = useUnlockStore.getState();
    await store.attach(transport);
    expect(useUnlockStore.getState().status).toBe('locked');

    await store.beginUnlock();
    expect(useUnlockStore.getState().status).toBe('unlocked');
    expect(useUnlockStore.getState().error).toBeNull();
    // start + poll + refresh after the initial attach refresh
    expect(sendAndReceive).toHaveBeenCalledTimes(4);
  });

  it('beginUnlock surfaces a localized error and returns to locked on failure', async () => {
    // attach ok (locked), then UnlockStart throws → performUnlock rejects
    const { transport } = transportFor([LOCKED]);
    await useUnlockStore.getState().attach(transport);
    await useUnlockStore.getState().beginUnlock(); // next sendAndReceive throws 'out of replies'
    const s = useUnlockStore.getState();
    expect(s.status).toBe('locked');
    expect(s.error).toMatch(/アンロックに失敗/);
  });

  it('relock re-engages the lock and refreshes', async () => {
    // attach(unlocked) → relock: Lock reply + GetUnlockStatus(locked)
    const { transport } = transportFor([UNLOCKED, [0, 0], LOCKED]);
    const store = useUnlockStore.getState();
    await store.attach(transport);
    expect(useUnlockStore.getState().status).toBe('unlocked');
    await store.relock();
    expect(useUnlockStore.getState().status).toBe('locked');
  });

  it('detach aborts and clears state', async () => {
    const { transport } = transportFor([LOCKED]);
    await useUnlockStore.getState().attach(transport);
    useUnlockStore.getState().detach();
    const s = useUnlockStore.getState();
    expect(s.transport).toBeNull();
    expect(s.status).toBe('unknown');
    expect(s.chord).toEqual([]);
  });
});
