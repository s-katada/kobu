/**
 * Vial unlock-chord helpers.
 *
 * Vial requires the user to physically hold a configured key combo
 * before keymap writes are accepted. For kobu the chord is
 * `[[0, 0], [0, 9]]` — both outer pinkies, defined in
 * `firmware/keyboard.toml`.
 *
 * The state machine, in firmware terms:
 *   * GetUnlockStatus     returns current locked-ness and the chord
 *   * UnlockStart         arms a countdown; firmware now expects
 *                         UnlockPoll requests while the user is
 *                         holding the chord
 *   * UnlockPoll          decrements the counter while the chord
 *                         remains held; returns 0 remaining when
 *                         unlocked
 *   * Lock                re-engage manually
 *
 * vial-gui polls every 100 ms with a 50-tick total budget so the
 * full unlock takes ~5 s of held chord. We mirror those numbers
 * unless overridden.
 */

import type { WebHidTransport } from '../transport/webhid';
import {
  buildGetUnlockStatus,
  buildLock,
  buildUnlockPoll,
  buildUnlockStart,
  parseUnlockPoll,
  parseUnlockStatus,
  type UnlockPollResult,
  type UnlockStatus,
} from './commands';

export const DEFAULT_POLL_INTERVAL_MS = 100;
/** Maximum ticks we'll poll before giving up — 50 ticks × 100 ms = 5 s. */
export const DEFAULT_POLL_BUDGET = 60;

export async function fetchUnlockStatus(transport: WebHidTransport): Promise<UnlockStatus> {
  const reply = await transport.sendAndReceive(buildGetUnlockStatus());
  return parseUnlockStatus(reply);
}

export async function startUnlock(transport: WebHidTransport): Promise<void> {
  await transport.sendAndReceive(buildUnlockStart());
}

export async function pollUnlock(transport: WebHidTransport): Promise<UnlockPollResult> {
  const reply = await transport.sendAndReceive(buildUnlockPoll());
  return parseUnlockPoll(reply);
}

export async function lock(transport: WebHidTransport): Promise<void> {
  await transport.sendAndReceive(buildLock());
}

export interface UnlockOptions {
  /** ms between polls. Default 100. */
  pollIntervalMs?: number;
  /** Max number of polls before giving up. Default 60 (= 6 s). */
  budget?: number;
  /**
   * Called with every poll result so the UI can render a countdown.
   * Throwing aborts the unlock attempt.
   */
  onTick?: (result: UnlockPollResult, ticksRemaining: number) => void;
  /** External cancellation; throws `'cancelled'` if it resolves first. */
  signal?: AbortSignal;
}

/**
 * Drive the full unlock flow until the firmware reports unlocked or
 * the budget runs out. Yields each poll result through `onTick` so
 * the UI can show a progress bar.
 *
 * Rejects with one of:
 *   * `Error('unlock-timeout')` — budget exhausted
 *   * `Error('cancelled')` — signal aborted mid-flight
 *   * any TransportError raised by the underlying HID round trip
 */
export async function performUnlock(
  transport: WebHidTransport,
  options: UnlockOptions = {},
): Promise<UnlockPollResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const budget = options.budget ?? DEFAULT_POLL_BUDGET;

  await startUnlock(transport);

  for (let tick = 0; tick < budget; tick++) {
    if (options.signal?.aborted) throw new Error('cancelled');
    const result = await pollUnlock(transport);
    options.onTick?.(result, budget - tick - 1);
    if (!result.locked) return result;
    await sleep(pollIntervalMs, options.signal);
  }
  throw new Error('unlock-timeout');
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
