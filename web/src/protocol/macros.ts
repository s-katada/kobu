/**
 * Vial macro buffer: codec + transport helpers.
 *
 * The buffer is a flat `Uint8Array` of `MACRO_SPACE_SIZE` bytes (256 on
 * kobu) containing N concatenated macros separated by a `0x00`
 * terminator. The buffer always ends in trailing zeros; macros beyond
 * the last terminator are treated as empty.
 *
 * On-the-wire byte format (per `rmk-0.8.2/src/keyboard_macros.rs`):
 *
 *   0x00              end-of-macro / empty padding
 *   0x01 0x01 KC      Tap (1-byte HID keycode)
 *   0x01 0x02 KC      Press (key down)
 *   0x01 0x03 KC      Release (key up)
 *   0x01 0x04 b1 b2   Delay; decoded as `(b1.max(1)-1) + (b2.max(1)-1)*255`
 *                     to keep both bytes non-zero (0x00 would terminate
 *                     the macro). Encoded as `b1 = (delay % 255) + 1`,
 *                     `b2 = (delay / 255) + 1`.
 *   0x01 0x05..0x07   VIAL_MACRO_EXT (2-byte keycodes / unicode) —
 *                     RMK 0.8 logs and ignores these. We surface them
 *                     as a generic `unsupported` action so existing
 *                     non-empty buffers round-trip rather than
 *                     silently clobbering.
 *   else (ASCII)      Text — RMK interprets a printable byte as
 *                     "tap this character, applying shift if needed".
 *                     We surface it as `{kind: 'text', byte}` so the
 *                     UI shows the literal character.
 */

import type { WebHidTransport } from '../transport/webhid';
import {
  buildMacroGetBuffer,
  buildMacroGetBufferSize,
  buildMacroGetCount,
  buildMacroSetBuffer,
  parseGetBufferPayload,
  parseMacroBufferSize,
  parseMacroCount,
} from './commands';

/** Max payload bytes per `Macro(Get|Set)Buffer` reply / packet. */
export const MACRO_CHUNK = 28;

export type MacroAction =
  | { kind: 'tap'; keycode: number }
  | { kind: 'down'; keycode: number }
  | { kind: 'up'; keycode: number }
  | { kind: 'delay'; ms: number }
  | { kind: 'text'; byte: number }
  | { kind: 'unsupported'; bytes: number[] };

export type MacroSequence = MacroAction[];

// ─── Encode ───────────────────────────────────────────────────────────────

/** Serialise one action to its on-the-wire bytes. */
export function encodeAction(action: MacroAction): Uint8Array {
  switch (action.kind) {
    case 'tap':
      return new Uint8Array([0x01, 0x01, action.keycode & 0xff]);
    case 'down':
      return new Uint8Array([0x01, 0x02, action.keycode & 0xff]);
    case 'up':
      return new Uint8Array([0x01, 0x03, action.keycode & 0xff]);
    case 'delay': {
      const ms = Math.max(0, Math.min(action.ms, 65025)); // 255 * 255
      const b1 = (ms % 255) + 1;
      const b2 = Math.floor(ms / 255) + 1;
      return new Uint8Array([0x01, 0x04, b1 & 0xff, b2 & 0xff]);
    }
    case 'text':
      return new Uint8Array([action.byte & 0xff]);
    case 'unsupported':
      return new Uint8Array(action.bytes);
  }
}

/** Encode one macro sequence, terminator-free. */
export function encodeSequence(sequence: MacroSequence): Uint8Array {
  const parts = sequence.map(encodeAction);
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encode N macro sequences into a fixed-size buffer.
 *
 * Layout: each non-empty sequence is followed by `0x00`. Empty
 * sequences are encoded as a bare `0x00`. The buffer is zero-padded to
 * `bufferSize`. Throws if the encoded length exceeds `bufferSize`.
 */
export function encodeBuffer(sequences: readonly MacroSequence[], bufferSize: number): Uint8Array {
  const buf = new Uint8Array(bufferSize);
  let offset = 0;
  for (const seq of sequences) {
    const encoded = encodeSequence(seq);
    if (offset + encoded.length + 1 > bufferSize) {
      throw new RangeError(
        `macro buffer overflow: need ${offset + encoded.length + 1} bytes, have ${bufferSize}`,
      );
    }
    buf.set(encoded, offset);
    offset += encoded.length;
    buf[offset] = 0x00;
    offset += 1;
  }
  return buf;
}

// ─── Decode ───────────────────────────────────────────────────────────────

/**
 * Parse one sequence starting at `start`. Returns the actions and the
 * index of the terminating `0x00` (or `buffer.length` if the sequence
 * runs to the end of the buffer without a terminator — defensive,
 * shouldn't happen on a well-formed firmware buffer).
 */
export function decodeSequence(
  buffer: Uint8Array,
  start: number,
): { actions: MacroSequence; nextStart: number } {
  const actions: MacroSequence = [];
  let i = start;
  while (i < buffer.length) {
    const b0 = buffer[i] ?? 0;
    if (b0 === 0x00) {
      return { actions, nextStart: i + 1 };
    }
    if (b0 === 0x01) {
      const b1 = buffer[i + 1] ?? 0;
      switch (b1) {
        case 0x01:
        case 0x02:
        case 0x03: {
          const kc = buffer[i + 2] ?? 0;
          const kind = b1 === 0x01 ? 'tap' : b1 === 0x02 ? 'down' : 'up';
          actions.push({ kind, keycode: kc });
          i += 3;
          continue;
        }
        case 0x04: {
          const bA = buffer[i + 2] ?? 1;
          const bB = buffer[i + 3] ?? 1;
          const ms = (Math.max(1, bA) - 1) + (Math.max(1, bB) - 1) * 255;
          actions.push({ kind: 'delay', ms });
          i += 4;
          continue;
        }
        case 0x05:
        case 0x06:
        case 0x07: {
          // VIAL_MACRO_EXT — RMK 0.8 ignores. Preserve raw bytes so a
          // round-trip read+write doesn't silently delete the action.
          // EXT layout per Vial: 1-byte tag + 2-byte keycode (LE).
          const raw = [b0, b1, buffer[i + 2] ?? 0, buffer[i + 3] ?? 0];
          actions.push({ kind: 'unsupported', bytes: raw });
          i += 4;
          continue;
        }
        default:
          // Unknown sub-tag — treat as a single-byte literal so we
          // don't lose sync with the rest of the buffer.
          actions.push({ kind: 'text', byte: b0 });
          i += 1;
          continue;
      }
    }
    // Anything else is a literal ASCII text byte per RMK semantics.
    actions.push({ kind: 'text', byte: b0 });
    i += 1;
  }
  return { actions, nextStart: i };
}

/**
 * Split a macro buffer into `count` sequences. Trailing zero padding
 * yields empty sequences. Macros beyond `count` separators are
 * discarded (defensive — firmware buffer should always have enough
 * terminators).
 */
export function decodeBuffer(buffer: Uint8Array, count: number): MacroSequence[] {
  const result: MacroSequence[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const { actions, nextStart } = decodeSequence(buffer, cursor);
    result.push(actions);
    cursor = nextStart;
  }
  return result;
}

// ─── Transport ────────────────────────────────────────────────────────────

export async function fetchMacroCount(transport: WebHidTransport): Promise<number> {
  const reply = await transport.sendAndReceive(buildMacroGetCount());
  return parseMacroCount(reply);
}

export async function fetchMacroBufferSize(transport: WebHidTransport): Promise<number> {
  const reply = await transport.sendAndReceive(buildMacroGetBufferSize());
  return parseMacroBufferSize(reply);
}

/**
 * Read the entire macro buffer in 28-byte chunks (same chunking
 * convention as the keymap GetBuffer flow).
 */
export async function fetchMacroBuffer(
  transport: WebHidTransport,
  bufferSize: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(bufferSize);
  for (let offset = 0; offset < bufferSize; offset += MACRO_CHUNK) {
    const size = Math.min(MACRO_CHUNK, bufferSize - offset);
    const reply = await transport.sendAndReceive(buildMacroGetBuffer(offset, size));
    const payload = parseGetBufferPayload(reply);
    out.set(payload.subarray(0, size), offset);
  }
  return out;
}

/**
 * Write the entire macro buffer back to the firmware. RMK 0.8 zeroes
 * its in-memory cache when offset=0, so the rewrite must start at 0
 * even if only the tail bytes changed.
 *
 * `onProgress` (if provided) is called after each chunk with the byte
 * count written so far so the UI can render a progress bar.
 */
export async function writeMacroBuffer(
  transport: WebHidTransport,
  buffer: Uint8Array,
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  for (let offset = 0; offset < buffer.length; offset += MACRO_CHUNK) {
    const size = Math.min(MACRO_CHUNK, buffer.length - offset);
    const chunk = buffer.subarray(offset, offset + size);
    await transport.sendAndReceive(buildMacroSetBuffer(offset, chunk));
    onProgress?.(offset + size, buffer.length);
  }
}
