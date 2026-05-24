/**
 * QMK Via "Custom Value" channel protocol for kobu-specific runtime
 * config.
 *
 * The Via spec carves out `CustomSetValue (0x07)` / `CustomGetValue
 * (0x08)` / `CustomSave (0x09)` for keyboard-defined channels. Channel
 * IDs 0x00..0x05 are reserved for QMK domains (Backlight / RGB Light /
 * RGB Matrix / LED Matrix / Audio / OLED) — anything above is fair
 * game.
 *
 * kobu claims channel `0xC0` and exposes one value per row of issue
 * #39's settings table. The value IDs match `firmware/src/config.rs`
 * so the host and firmware never have to negotiate.
 *
 * Wire format:
 *
 *   request:  [0x07, channel, id, ...value-bytes (BE)]    SetCustomValue
 *             [0x08, channel, id]                          GetCustomValue
 *             [0x09, channel, id]                          CustomSave
 *
 *   reply:    GetCustomValue echoes back the request bytes 0..2
 *             followed by `...value-bytes` starting at byte 3 (BE).
 *
 * Values are encoded BE (Via convention for `Via*` commands). Lengths
 * are fixed per value-id so callers don't have to think about it.
 *
 * ⚠ The firmware-side handler is intentionally not wired up yet — see
 * issue #39's "Deferred" section. The protocol layer here ships first
 * so the host UI can be reviewed independently and ready to flip on
 * the moment the firmware control plane lands.
 */

import { emptyPacket, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { readU16BE, ViaCommand } from './commands';

/** kobu-editor channel. Must match `firmware/src/config.rs`. */
export const KOBU_CHANNEL = 0xc0;

/**
 * Per-value type — matches the firmware schema. Affects the wire
 * encoding (length, byte order) and the UI representation (slider /
 * toggle / number).
 */
export type ValueType = 'u16' | 'u8' | 'bool';

/**
 * Static catalogue of every kobu setting that lives on the Custom
 * Value channel. Order matters only insofar as the UI walks the list;
 * the firmware looks each entry up by `id`.
 *
 * Keep this list in sync with:
 *   * `firmware/src/config.rs::KobuSettings`
 *   * issue #39's settings table
 */
export interface ValueDef {
  id: number;
  /** kebab-case key used by the store + UI to address the slot. */
  key:
    | 'trackball_cpi'
    | 'scroll_throttle_ms'
    | 'scroll_invert_x'
    | 'scroll_invert_y'
    | 'status_led_purple_hold_ms'
    | 'status_led_battery_high_threshold'
    | 'status_led_battery_low_threshold';
  type: ValueType;
  /** Closed range `[min, max]`. The UI clamps to this; the firmware
   *  also clamps to its own range as a defence-in-depth check. */
  min: number;
  max: number;
  /** Default value if the firmware doesn't respond / returns an
   *  out-of-range value. Matches the firmware's own defaults so a
   *  fresh keyboard reads as "untouched, ready to tune". */
  default: number;
}

export const KOBU_VALUES: readonly ValueDef[] = Object.freeze([
  { id: 0x01, key: 'trackball_cpi', type: 'u16', min: 200, max: 3200, default: 1000 },
  { id: 0x02, key: 'scroll_throttle_ms', type: 'u8', min: 0, max: 50, default: 0 },
  { id: 0x03, key: 'scroll_invert_x', type: 'bool', min: 0, max: 1, default: 0 },
  { id: 0x04, key: 'scroll_invert_y', type: 'bool', min: 0, max: 1, default: 0 },
  { id: 0x05, key: 'status_led_purple_hold_ms', type: 'u16', min: 0, max: 2000, default: 200 },
  {
    id: 0x06,
    key: 'status_led_battery_high_threshold',
    type: 'u8',
    min: 20,
    max: 100,
    default: 60,
  },
  { id: 0x07, key: 'status_led_battery_low_threshold', type: 'u8', min: 0, max: 50, default: 20 },
]);

export type KobuSettingKey = (typeof KOBU_VALUES)[number]['key'];

/** Bytes-per-value, derived from the `type` tag. */
export function valueBytes(type: ValueType): number {
  switch (type) {
    case 'u16':
      return 2;
    case 'u8':
    case 'bool':
      return 1;
  }
}

// ─── Builders ─────────────────────────────────────────────────────────

/**
 * Via `CustomGetValue` for the kobu channel.
 *
 *   packet[0] = 0x08
 *   packet[1] = channel (0xC0)
 *   packet[2] = id
 */
export function buildKobuGetValue(id: number): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.CustomGetValue;
  p[1] = KOBU_CHANNEL;
  p[2] = id & 0xff;
  return p;
}

/**
 * Via `CustomSetValue` for the kobu channel.
 *
 *   packet[0]    = 0x07
 *   packet[1]    = channel (0xC0)
 *   packet[2]    = id
 *   packet[3..]  = value bytes, BE
 */
export function buildKobuSetValue(def: ValueDef, value: number): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.CustomSetValue;
  p[1] = KOBU_CHANNEL;
  p[2] = def.id & 0xff;
  const bytes = valueBytes(def.type);
  if (bytes === 2) {
    p[3] = (value >> 8) & 0xff;
    p[4] = value & 0xff;
  } else {
    p[3] = value & 0xff;
  }
  return p;
}

/**
 * Via `CustomSave` for the kobu channel. RMK persists writes
 * immediately so this is a no-op, but we issue it for parity with
 * vial-gui-style tooling that expects an explicit flush.
 */
export function buildKobuCustomSave(id: number): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.CustomSave;
  p[1] = KOBU_CHANNEL;
  p[2] = id & 0xff;
  return p;
}

// ─── Parser ───────────────────────────────────────────────────────────

/**
 * Decode the reply to a `CustomGetValue` for the given value def.
 * Reads BE u16 or u8 starting at `reply[3]`.
 *
 * If the firmware returns a value outside the def's `[min, max]`, the
 * caller should treat it as "firmware does not implement this slot
 * yet" and fall back to the default — we're conservative because the
 * RMK 0.8 stub handler doesn't write any payload, leaving stale
 * buffer contents at offset 3.
 */
export function parseKobuGetValue(def: ValueDef, reply: VialPacket): number {
  const bytes = valueBytes(def.type);
  if (bytes === 2) return readU16BE(reply, 3);
  return reply[3] ?? 0;
}

// ─── Transport ────────────────────────────────────────────────────────

export async function getKobuValue(transport: WebHidTransport, def: ValueDef): Promise<number> {
  const reply = await transport.sendAndReceive(buildKobuGetValue(def.id));
  const value = parseKobuGetValue(def, reply);
  if (value < def.min || value > def.max) return def.default;
  return value;
}

export async function setKobuValue(
  transport: WebHidTransport,
  def: ValueDef,
  value: number,
): Promise<void> {
  const clamped = Math.max(def.min, Math.min(def.max, value | 0));
  await transport.sendAndReceive(buildKobuSetValue(def, clamped));
}

/**
 * Bulk read every kobu setting. Used on attach; the panel renders
 * the returned snapshot directly.
 */
export async function fetchKobuSettings(
  transport: WebHidTransport,
): Promise<Record<KobuSettingKey, number>> {
  const out = {} as Record<KobuSettingKey, number>;
  for (const def of KOBU_VALUES) {
    out[def.key] = await getKobuValue(transport, def);
  }
  return out;
}
