/**
 * Vial / Via command catalogue and packet builders.
 *
 * Each builder writes the byte layout for one command into a fresh
 * 32-byte `VialPacket`. The `parse*` helpers read structured values
 * out of the matching reply. Keeping both halves of a round-trip in
 * the same file makes the wire format trivially auditable against the
 * RMK source (`rmk-types-0.2.2/src/protocol/vial.rs`) and the vial-gui
 * reference (`vial-kb/vial-gui/protocol/constants.py`).
 *
 * Byte-order convention:
 *   * `Via*` (= QMK-origin) commands serialise multi-byte values BIG-endian.
 *   * `Vial*` commands serialise multi-byte values LITTLE-endian.
 *
 * This file is transport-agnostic; pair the builders with
 * `WebHidTransport.sendAndReceive` to actually talk to kobu.
 */

import { emptyPacket, type VialPacket } from '../transport/types';

// ─── Top-level command ids (`packet[0]`) ──────────────────────────────────

export const ViaCommand = {
  GetProtocolVersion: 0x01,
  GetKeyboardValue: 0x02,
  SetKeyboardValue: 0x03,
  DynamicKeymapGetKeyCode: 0x04,
  DynamicKeymapSetKeyCode: 0x05,
  DynamicKeymapReset: 0x06,
  CustomSetValue: 0x07,
  CustomGetValue: 0x08,
  CustomSave: 0x09,
  EepromReset: 0x0a,
  BootloaderJump: 0x0b,
  DynamicKeymapMacroGetCount: 0x0c,
  DynamicKeymapMacroGetBufferSize: 0x0d,
  DynamicKeymapMacroGetBuffer: 0x0e,
  DynamicKeymapMacroSetBuffer: 0x0f,
  DynamicKeymapMacroReset: 0x10,
  DynamicKeymapGetLayerCount: 0x11,
  DynamicKeymapGetBuffer: 0x12,
  DynamicKeymapSetBuffer: 0x13,
  Vial: 0xfe,
} as const;

// ─── Sub-command ids under `ViaCommand.Vial` (= packet[1]) ────────────────

export const VialSubCommand = {
  GetKeyboardId: 0x00,
  GetSize: 0x01,
  GetKeyboardDef: 0x02,
  GetEncoder: 0x03,
  SetEncoder: 0x04,
  GetUnlockStatus: 0x05,
  UnlockStart: 0x06,
  UnlockPoll: 0x07,
  Lock: 0x08,
  DynamicEntryOp: 0x0d,
} as const;

// ─── Builders ─────────────────────────────────────────────────────────────

/**
 * Via `GetProtocolVersion` — returns the Via protocol version as a
 * BE-u16 in `reply[1..3]`. RMK 0.8 hardcodes this to `0x0009`.
 */
export function buildGetProtocolVersion(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.GetProtocolVersion;
  return p;
}

/**
 * Vial `GetKeyboardId` — returns:
 *   reply[2..6]   Vial protocol version, LE u32
 *   reply[6..14]  Keyboard UID (8 bytes — the same value baked into
 *                 `firmware/build.rs::VIAL_KEYBOARD_ID`)
 *   reply[14]     Vial feature flags (1 = vialrgb)
 */
export function buildGetKeyboardId(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.Vial;
  p[1] = VialSubCommand.GetKeyboardId;
  return p;
}

/**
 * Vial `GetSize` — returns the total byte length of the XZ-compressed
 * keyboard definition as LE u32 in `reply[0..4]`.
 */
export function buildGetSize(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.Vial;
  p[1] = VialSubCommand.GetSize;
  return p;
}

/**
 * Vial `GetKeyboardDef` — fetch a 32-byte page of the XZ definition.
 * Page index goes in `packet[2..4]` (LE u16); the reply contains the
 * raw page bytes — no length prefix.
 */
export function buildGetKeyboardDef(pageIndex: number): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.Vial;
  p[1] = VialSubCommand.GetKeyboardDef;
  writeU16LE(p, 2, pageIndex);
  return p;
}

/**
 * Via `DynamicKeymapGetLayerCount` — returns the number of layers the
 * firmware was built with as a single byte in `reply[1]`.
 */
export function buildGetLayerCount(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapGetLayerCount;
  return p;
}

/**
 * Via `DynamicKeymapGetBuffer` — read a contiguous range of the
 * flattened keymap. Offset and size are big-endian (it's a Via, not
 * Vial, command).
 *
 *   packet[1..3] = offset (BE u16, in bytes from buffer start)
 *   packet[3]    = size   (u8, 1..28 — the response only carries 28
 *                          payload bytes after the 4-byte header echo)
 *
 * The reply layout is `[cmd, offset_hi, offset_lo, size, ...payload]`.
 */
export function buildGetBuffer(offset: number, size: number): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapGetBuffer;
  p[1] = (offset >> 8) & 0xff;
  p[2] = offset & 0xff;
  p[3] = size & 0xff;
  return p;
}

/**
 * Via `DynamicKeymapSetKeyCode` — set one logical key.
 *
 *   packet[1] = layer index
 *   packet[2] = row
 *   packet[3] = col
 *   packet[4..6] = keycode (BE u16)
 */
export function buildSetKeyCode(
  layer: number,
  row: number,
  col: number,
  keycode: number,
): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapSetKeyCode;
  p[1] = layer & 0xff;
  p[2] = row & 0xff;
  p[3] = col & 0xff;
  p[4] = (keycode >> 8) & 0xff;
  p[5] = keycode & 0xff;
  return p;
}

/**
 * Via `DynamicKeymapReset` — clobber the flash-stored keymap back to
 * the firmware's build-time defaults. No payload.
 */
export function buildKeymapReset(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapReset;
  return p;
}

/**
 * Vial `GetUnlockStatus` — returns the current unlock state plus the
 * list of physical keys configured as the unlock chord (kobu's
 * `unlock_keys` from keyboard.toml).
 */
export function buildGetUnlockStatus(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.Vial;
  p[1] = VialSubCommand.GetUnlockStatus;
  return p;
}

/** Vial `UnlockStart` — arm the unlock state machine. */
export function buildUnlockStart(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.Vial;
  p[1] = VialSubCommand.UnlockStart;
  return p;
}

/**
 * Vial `UnlockPoll` — call every ~100 ms while the unlock chord is
 * being held. Returns:
 *
 *   reply[0] = locked (1) or unlocked (0)
 *   reply[1] = unlock-in-progress flag
 *   reply[2] = remaining counter (counts down to 0)
 */
export function buildUnlockPoll(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.Vial;
  p[1] = VialSubCommand.UnlockPoll;
  return p;
}

/** Vial `Lock` — re-engage the lock manually. */
export function buildLock(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.Vial;
  p[1] = VialSubCommand.Lock;
  return p;
}

/**
 * Via `EepromReset` — clobber every persisted value, including bond
 * information. Use with care: on kobu this also drops the BLE
 * pairings since RMK stores them in the same sequential-storage
 * region as the keymap.
 *
 * If you only want to wipe the keymap, use `buildKeymapReset`
 * instead — that one preserves bonds.
 */
export function buildEepromReset(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.EepromReset;
  return p;
}

/**
 * Via `CustomSave` — instruct the firmware to flush any pending
 * `CustomSetValue` writes to flash. RMK already persists on every
 * write so this is a no-op on kobu, but vial-gui issues it after
 * lighting tweaks and we keep parity for compatibility with any
 * tooling that piggy-backs on the kobu-config transport.
 */
export function buildCustomSave(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.CustomSave;
  return p;
}

/**
 * Via `BootloaderJump` — restart into the XIAO BLE's UF2 mass-storage
 * bootloader. Equivalent to double-tapping the RESET button on the
 * board: the firmware reboots, the bootloader enumerates the
 * `XIAO-BOOT` USB volume, and the firmware Vial endpoint goes away.
 *
 * The transport will drop the moment the firmware reboots, so callers
 * should treat `send-failed` / `disconnected` as the expected outcome
 * (not an error to surface).
 */
export function buildBootloaderJump(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.BootloaderJump;
  return p;
}

// ─── Macro builders ───────────────────────────────────────────────────────

/**
 * Via `DynamicKeymapMacroGetCount` — how many macro slots the firmware
 * exposes. RMK 0.8 hardcodes this to 32, regardless of the
 * `macro_space_size` from `keyboard.toml`.
 *
 * The reply puts the count in `reply[1]`.
 */
export function buildMacroGetCount(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapMacroGetCount;
  return p;
}

/**
 * Via `DynamicKeymapMacroGetBufferSize` — total bytes the firmware
 * reserves for the concatenated macro sequences (== `macro_space_size`
 * in `keyboard.toml`).
 *
 * The reply encodes the size as **big-endian u16** at `reply[1..3]` —
 * `[cmd, hi, lo]`, no further bytes. This matches the standard
 * convention for Via (`Via*`) commands.
 */
export function buildMacroGetBufferSize(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapMacroGetBufferSize;
  return p;
}

/**
 * Via `DynamicKeymapMacroGetBuffer` — read a contiguous range of the
 * macro buffer. Offset is **big-endian** at `packet[1..3]`; size at
 * `packet[3]` (max 28).
 *
 * The reply echoes back `[cmd, offset_hi, offset_lo, size, ...payload]`
 * — same shape as `GetBuffer` for the keymap.
 */
export function buildMacroGetBuffer(offset: number, size: number): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapMacroGetBuffer;
  p[1] = (offset >> 8) & 0xff;
  p[2] = offset & 0xff;
  p[3] = size & 0xff;
  return p;
}

/**
 * Via `DynamicKeymapMacroSetBuffer` — write a contiguous range of the
 * macro buffer.
 *
 *   packet[1..3] = offset (BE u16)
 *   packet[3]    = size   (u8, 1..28)
 *   packet[4..]  = bytes to write
 *
 * RMK 0.8 zeroes the firmware-side cache when `offset == 0`, so callers
 * must start the rewrite at offset 0 even if only a tail byte changed.
 * After every chunk the firmware flushes the entire cache to flash.
 */
export function buildMacroSetBuffer(offset: number, data: Uint8Array): VialPacket {
  if (data.length > 28) {
    throw new RangeError(`macro chunk too large: ${data.length} > 28`);
  }
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapMacroSetBuffer;
  p[1] = (offset >> 8) & 0xff;
  p[2] = offset & 0xff;
  p[3] = data.length & 0xff;
  p.set(data, 4);
  return p;
}

/**
 * Via `DynamicKeymapMacroReset` — clobber every macro back to empty.
 * RMK 0.8 logs but does not act on this command; callers should
 * achieve the same effect by writing an all-zero buffer with
 * `buildMacroSetBuffer`.
 */
export function buildMacroReset(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.DynamicKeymapMacroReset;
  return p;
}

// ─── Parsers ──────────────────────────────────────────────────────────────

export interface KeyboardId {
  vialProtocolVersion: number;
  uid: Uint8Array;
  featureFlags: number;
}

export function parseProtocolVersion(reply: VialPacket): number {
  return readU16BE(reply, 1);
}

export function parseKeyboardId(reply: VialPacket): KeyboardId {
  return {
    vialProtocolVersion: readU32LE(reply, 0),
    uid: reply.slice(4, 12),
    featureFlags: reply[12] ?? 0,
  };
}

export function parseSize(reply: VialPacket): number {
  return readU32LE(reply, 0);
}

/**
 * Via `DynamicKeymapGetLayerCount` returns the layer count as a single
 * byte in `reply[1]`. Returns 0 if the byte is missing.
 */
export function parseLayerCount(reply: VialPacket): number {
  return reply[1] ?? 0;
}

/**
 * Read the keymap payload from a `DynamicKeymapGetBuffer` reply.
 * The first 4 bytes echo the request header (cmd / offset hi / offset
 * lo / size); the remaining bytes are the payload.
 */
export function parseGetBufferPayload(reply: VialPacket): Uint8Array {
  const size = reply[3] ?? 0;
  return reply.slice(4, 4 + size);
}

export interface UnlockStatus {
  locked: boolean;
  inProgress: boolean;
  /** Physical (row, col) positions that make up the unlock chord. */
  chord: Array<{ row: number; col: number }>;
}

/**
 * Parse the response from `GetUnlockStatus`. RMK's `VialLock` writes:
 *
 *   reply[0]     locked flag
 *   reply[1]     in-progress flag
 *   reply[2..]   pairs of (row, col); (0xff, 0xff) marks end of list.
 */
export function parseUnlockStatus(reply: VialPacket): UnlockStatus {
  const locked = (reply[0] ?? 1) !== 0;
  const inProgress = (reply[1] ?? 0) !== 0;
  const chord: Array<{ row: number; col: number }> = [];
  for (let i = 2; i + 1 < reply.length; i += 2) {
    const row = reply[i] ?? 0xff;
    const col = reply[i + 1] ?? 0xff;
    if (row === 0xff && col === 0xff) break;
    chord.push({ row, col });
  }
  return { locked, inProgress, chord };
}

export interface UnlockPollResult {
  locked: boolean;
  inProgress: boolean;
  remaining: number;
}

export function parseUnlockPoll(reply: VialPacket): UnlockPollResult {
  return {
    locked: (reply[0] ?? 1) !== 0,
    inProgress: (reply[1] ?? 0) !== 0,
    remaining: reply[2] ?? 0,
  };
}

/**
 * Number of macro slots the firmware was built with (RMK 0.8 returns
 * 32 hardcoded). Reads `reply[1]`.
 */
export function parseMacroCount(reply: VialPacket): number {
  return reply[1] ?? 0;
}

/**
 * Total byte capacity of the macro buffer. RMK 0.8 emits BE u16 at
 * `reply[1..3]` (NOT LE — see `buildMacroGetBufferSize`).
 */
export function parseMacroBufferSize(reply: VialPacket): number {
  return readU16BE(reply, 1);
}

// ─── Byte helpers ─────────────────────────────────────────────────────────
//
// Stay tied to indexed access so noUncheckedIndexedAccess gives us a
// safety net at every step; ternaries on the read side and explicit
// `& 0xff` masks on writes keep this readable.

export function readU16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0);
}

export function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] ?? 0) |
    ((buf[offset + 1] ?? 0) << 8) |
    ((buf[offset + 2] ?? 0) << 16) |
    (((buf[offset + 3] ?? 0) << 24) >>> 0)
  );
}

export function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}
