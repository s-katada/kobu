/**
 * Vial morse (tap-dance) entries — fetch / write helpers.
 *
 * RMK 0.8 calls these "morses" internally (`rmk-0.8.2/src/morse.rs`);
 * Vial GUI calls them "tap dance" — same wire format and same
 * `DynamicEntryOp` sub-id (0x01 / 0x02). One entry per slot, 4
 * keycodes (tap / hold / double-tap / hold-after-tap) plus a single
 * `tap_term_ms` window.
 *
 * The wire reply lives in `commands.ts::parseMorseGet`; this file is
 * the transport-layer convenience around it (mirrors the shape of
 * `combos.ts`).
 */

import type { WebHidTransport } from '../transport/webhid';
import { buildMorseGet, buildMorseSet, type MorseEntry, parseMorseGet } from './commands';

/** Sensible default for the tap-vs-hold decision window. */
export const DEFAULT_TAP_TERM_MS = 200;

/** Minimum tap term we let the UI commit (below this hold is unusable). */
export const MIN_TAP_TERM_MS = 50;

/** Maximum tap term — beyond ~1s hold actions feel "stuck". */
export const MAX_TAP_TERM_MS = 1000;

export async function fetchMorse(transport: WebHidTransport, index: number): Promise<MorseEntry> {
  const reply = await transport.sendAndReceive(buildMorseGet(index));
  return parseMorseGet(reply);
}

export async function fetchAllMorses(
  transport: WebHidTransport,
  count: number,
): Promise<MorseEntry[]> {
  const out: MorseEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await fetchMorse(transport, i));
  }
  return out;
}

export async function setMorse(
  transport: WebHidTransport,
  index: number,
  entry: MorseEntry,
): Promise<void> {
  await transport.sendAndReceive(buildMorseSet(index, entry));
}

export function entriesEqual(a: MorseEntry, b: MorseEntry): boolean {
  return (
    a.tap === b.tap &&
    a.hold === b.hold &&
    a.doubleTap === b.doubleTap &&
    a.holdAfterTap === b.holdAfterTap &&
    a.tapTermMs === b.tapTermMs
  );
}

export function emptyMorse(): MorseEntry {
  return {
    tap: 0,
    hold: 0,
    doubleTap: 0,
    holdAfterTap: 0,
    tapTermMs: DEFAULT_TAP_TERM_MS,
  };
}
