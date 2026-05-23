/**
 * Vial dynamic combo entries — fetch / write helpers on top of the
 * raw `DynamicEntryOp` builders in `commands.ts`.
 *
 * A combo entry is 4 input keycodes + 1 output keycode. RMK 0.8 (and
 * vial-gui) treat an entry with all-zero inputs AND all-zero output
 * as "disabled" — the firmware turns it into `None` internally.
 *
 * Wire format reminder (see `buildComboGet` / `buildComboSet`):
 *   request:  [0xFE, 0x0D, sub, idx, in0_lo, in0_hi, ..., out_lo, out_hi]
 *   reply:    [rc,   in0_lo, in0_hi, ..., out_lo, out_hi]    on Get
 *             [rc, ...]                                       on Set
 *
 * Keycodes are Via 16-bit values — the same encoding the keymap and
 * macro keycode picker emit, so combos can share the picker UI.
 */

import type { WebHidTransport } from '../transport/webhid';
import {
  buildComboGet,
  buildComboSet,
  buildGetNumberOfEntries,
  type ComboEntry,
  type DynamicEntryCounts,
  parseComboGet,
  parseNumberOfEntries,
} from './commands';

/** Inputs per combo on the Vial wire. */
export const COMBO_INPUTS = 4;

export async function fetchDynamicEntryCounts(
  transport: WebHidTransport,
): Promise<DynamicEntryCounts> {
  const reply = await transport.sendAndReceive(buildGetNumberOfEntries());
  return parseNumberOfEntries(reply);
}

export async function fetchCombo(transport: WebHidTransport, index: number): Promise<ComboEntry> {
  const reply = await transport.sendAndReceive(buildComboGet(index));
  return parseComboGet(reply);
}

/**
 * Fetch all `count` combos in slot order. Issues `count` sequential
 * round trips (one per entry — there is no batch read in the Vial
 * protocol).
 */
export async function fetchAllCombos(
  transport: WebHidTransport,
  count: number,
): Promise<ComboEntry[]> {
  const out: ComboEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await fetchCombo(transport, i));
  }
  return out;
}

export async function setCombo(
  transport: WebHidTransport,
  index: number,
  entry: ComboEntry,
): Promise<void> {
  await transport.sendAndReceive(buildComboSet(index, entry.inputs, entry.output));
}

/** Two entries are equal iff every keycode slot matches. */
export function entriesEqual(a: ComboEntry, b: ComboEntry): boolean {
  return (
    a.output === b.output &&
    a.inputs[0] === b.inputs[0] &&
    a.inputs[1] === b.inputs[1] &&
    a.inputs[2] === b.inputs[2] &&
    a.inputs[3] === b.inputs[3]
  );
}

/** A fresh, all-zero combo entry — what a "disabled" slot looks like. */
export function emptyCombo(): ComboEntry {
  return { inputs: [0, 0, 0, 0], output: 0 };
}
