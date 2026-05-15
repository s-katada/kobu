import { describe, expect, it, vi } from 'vitest';
import { intoVialPacket, VIAL_PACKET_SIZE } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { parseUnlockStatus, ViaCommand, VialSubCommand } from './commands';
import { performUnlock } from './unlock';

function reply(bytes: number[]) {
  const buf = new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE));
  bytes.forEach((b, i) => {
    buf[i] = b;
  });
  return intoVialPacket(buf);
}

function transportFor(replies: number[][]) {
  let idx = 0;
  const sendAndReceive = vi.fn(async () => {
    const r = replies[idx++];
    if (!r) throw new Error('out of replies');
    return reply(r);
  });
  return { transport: { sendAndReceive } as unknown as WebHidTransport, sendAndReceive };
}

describe('parseUnlockStatus', () => {
  it('decodes locked flag + chord pairs', () => {
    const status = parseUnlockStatus(reply([1, 0, 0, 0, 0, 9, 0xff, 0xff, 7, 7]));
    expect(status.locked).toBe(true);
    expect(status.inProgress).toBe(false);
    expect(status.chord).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 9 },
    ]);
  });
});

describe('performUnlock', () => {
  it('returns success on the first unlocked poll', async () => {
    const { transport, sendAndReceive } = transportFor([
      // UnlockStart reply (ignored)
      [ViaCommand.Vial, VialSubCommand.UnlockStart],
      // UnlockPoll reply: locked=0 → done
      [0, 0, 0],
    ]);

    const tick = vi.fn();
    const result = await performUnlock(transport, { onTick: tick, pollIntervalMs: 1, budget: 5 });
    expect(result.locked).toBe(false);
    expect(sendAndReceive).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledOnce();
  });

  it('throws unlock-timeout when budget is exhausted', async () => {
    const { transport } = transportFor([
      [ViaCommand.Vial, VialSubCommand.UnlockStart],
      [1, 1, 30],
      [1, 1, 25],
      [1, 1, 20],
    ]);
    await expect(performUnlock(transport, { pollIntervalMs: 1, budget: 3 })).rejects.toThrow(
      'unlock-timeout',
    );
  });

  it('throws cancelled when the signal aborts mid-flight', async () => {
    const ac = new AbortController();
    const { transport } = transportFor([
      [ViaCommand.Vial, VialSubCommand.UnlockStart],
      [1, 1, 30],
      [1, 1, 25],
    ]);
    // Abort after the first poll has been issued.
    queueMicrotask(() => ac.abort());
    await expect(
      performUnlock(transport, {
        pollIntervalMs: 50,
        budget: 5,
        signal: ac.signal,
      }),
    ).rejects.toThrow('cancelled');
  });
});
