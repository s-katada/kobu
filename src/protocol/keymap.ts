/**
 * Keymap read / write operations on top of the WebHID transport.
 *
 * The Via keymap is a tightly packed `layers × rows × cols × 2 bytes`
 * flat buffer. For kobu (4 × 4 × 10 × 2) that's 320 bytes — fetched
 * in 28-byte chunks because Via reserves 4 bytes of every 32-byte
 * reply for the command echo (cmd, offset hi, offset lo, size).
 *
 * Keycodes are big-endian unsigned 16-bit values; the symbolic
 * mapping (e.g. `0x0014` = `Q`, `0x0840` = `User0`) lives in
 * `src/protocol/keycodes.ts` (Phase 3 work — until then callers see
 * raw numbers).
 */

import type { VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import {
  buildCustomSave,
  buildEepromReset,
  buildGetBuffer,
  buildGetLayerCount,
  buildKeymapReset,
  buildSetKeyCode,
  parseGetBufferPayload,
  parseLayerCount,
} from './commands';

/** Bytes per keycode on the wire. */
export const KEYCODE_BYTES = 2;

/**
 * Maximum payload bytes per `GetBuffer` reply. A 32-byte report holds
 * a 4-byte command echo + 28 bytes of payload. Smaller chunks waste
 * round trips; larger chunks don't fit.
 */
export const GET_BUFFER_CHUNK = 28;

export type Keycode = number;

/** `keymap[layer][row][col]` of raw `u16` keycodes. */
export type Keymap = Keycode[][][];

export interface KeymapDimensions {
  layers: number;
  rows: number;
  cols: number;
}

/** Total byte length of a keymap with these dimensions. */
function bufferSizeFor(dim: KeymapDimensions): number {
  return dim.layers * dim.rows * dim.cols * KEYCODE_BYTES;
}

export async function fetchLayerCount(transport: WebHidTransport): Promise<number> {
  const reply = await transport.sendAndReceive(buildGetLayerCount());
  return parseLayerCount(reply);
}

/**
 * Read every keycode by issuing `ceil(totalBytes / 28)` GetBuffer
 * commands serialised through the transport.
 *
 * Vial supports this whole-keymap read explicitly (vial.rocks uses
 * the same path), so this is the canonical way to refresh after a
 * reconnect or after a destructive write.
 */
export async function fetchKeymap(
  transport: WebHidTransport,
  dim: KeymapDimensions,
): Promise<Keymap> {
  const total = bufferSizeFor(dim);
  const flat = new Uint8Array(new ArrayBuffer(total));
  for (let offset = 0; offset < total; offset += GET_BUFFER_CHUNK) {
    const remaining = total - offset;
    const size = Math.min(GET_BUFFER_CHUNK, remaining);
    const reply = await transport.sendAndReceive(buildGetBuffer(offset, size));
    const payload = parseGetBufferPayload(reply);
    flat.set(payload.subarray(0, size), offset);
  }
  return decodeKeymap(flat, dim);
}

/**
 * Convert a flat `Uint8Array` of `u16` BE keycodes into a 3-D array.
 * Exported separately so tests can verify the shape without making a
 * real HID round trip.
 */
export function decodeKeymap(flat: Uint8Array, dim: KeymapDimensions): Keymap {
  const out: Keymap = [];
  let pos = 0;
  for (let layer = 0; layer < dim.layers; layer++) {
    const rows: Keycode[][] = [];
    for (let row = 0; row < dim.rows; row++) {
      const cols: Keycode[] = [];
      for (let col = 0; col < dim.cols; col++) {
        const hi = flat[pos] ?? 0;
        const lo = flat[pos + 1] ?? 0;
        cols.push((hi << 8) | lo);
        pos += KEYCODE_BYTES;
      }
      rows.push(cols);
    }
    out.push(rows);
  }
  return out;
}

/**
 * Write a single keycode. Returns the reply for the caller to inspect
 * (the firmware echoes back the request; non-matching values usually
 * indicate the device was locked and the write was rejected).
 */
export async function setKeycode(
  transport: WebHidTransport,
  layer: number,
  row: number,
  col: number,
  keycode: Keycode,
): Promise<VialPacket> {
  return transport.sendAndReceive(buildSetKeyCode(layer, row, col, keycode));
}

/** Reset the entire keymap to firmware build-time defaults. */
export async function resetKeymap(transport: WebHidTransport): Promise<void> {
  await transport.sendAndReceive(buildKeymapReset());
}

/**
 * **Destructive.** Wipe all persisted state — keymap, macros,
 * combos, AND BLE bond information. On kobu this drops every paired
 * host because RMK stores keymap + bonds in the same
 * sequential-storage region. Prefer `resetKeymap` when bonds should
 * survive.
 */
export async function eepromReset(transport: WebHidTransport): Promise<void> {
  await transport.sendAndReceive(buildEepromReset());
}

/**
 * Vial-compat no-op on kobu. RMK persists each `CustomSetValue` on
 * write, so there is nothing for the firmware to flush — but the
 * command exists on the wire for tooling that expects a save step
 * (vial-gui issues it after lighting changes).
 */
export async function customSave(transport: WebHidTransport): Promise<void> {
  await transport.sendAndReceive(buildCustomSave());
}
