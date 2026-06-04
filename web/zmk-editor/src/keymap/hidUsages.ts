/**
 * HID usage encoding/decoding + human labels for ZMK key-press params.
 *
 * A `&kp` binding stores its key in `param1` as a 32-bit value:
 *
 *     (mods << 24) | (page << 16) | id
 *
 * where `page` is the HID usage page (0x07 keyboard, 0x0C consumer), `id`
 * is the usage within that page, and `mods` is the implicit-modifier
 * bitfield (so `LC(A)` = Ctrl+A is a single keycode). This matches ZMK's
 * `ZMK_HID_USAGE` / `dt-bindings/zmk/keys.h`.
 *
 * The live editor only needs this for parameters the device's behavior
 * metadata marks as a HID usage; layer-ids and named constants are
 * labelled from the device metadata instead (see `binding.ts`).
 */

export const HID_USAGE_KEY = 0x07;
export const HID_USAGE_CONSUMER = 0x0c;

export interface DecodedKeycode {
  mods: number;
  page: number;
  id: number;
}

export function decodeKeycode(param: number): DecodedKeycode {
  return {
    mods: (param >>> 24) & 0xff,
    page: (param >>> 16) & 0xff,
    id: param & 0xffff,
  };
}

export function encodeKeycode(page: number, id: number, mods = 0): number {
  // `>>> 0` keeps the result an unsigned 32-bit number (the top mod bit
  // would otherwise make it negative).
  return (((mods & 0xff) << 24) | ((page & 0xff) << 16) | (id & 0xffff)) >>> 0;
}

const MOD_BITS: ReadonlyArray<readonly [number, string]> = [
  [0x01, 'Ctrl'],
  [0x02, 'Shift'],
  [0x04, 'Alt'],
  [0x08, 'Cmd'],
  [0x10, 'RCtrl'],
  [0x20, 'RShift'],
  [0x40, 'RAlt'],
  [0x80, 'RCmd'],
];

export const MOD_LCTL = 0x01;
export const MOD_LSFT = 0x02;
export const MOD_LALT = 0x04;
export const MOD_LGUI = 0x08;

export function modsLabel(mods: number): string {
  return MOD_BITS.filter(([bit]) => (mods & bit) !== 0)
    .map(([, name]) => name)
    .join('+');
}

// --- keyboard page (0x07) labels ---
const keyPage = new Map<number, string>();
for (let i = 0; i < 26; i++) keyPage.set(0x04 + i, String.fromCharCode(65 + i)); // A–Z
for (let i = 0; i < 9; i++) keyPage.set(0x1e + i, String(i + 1)); // 1–9
keyPage.set(0x27, '0');
for (let i = 0; i < 12; i++) keyPage.set(0x3a + i, `F${i + 1}`); // F1–F12
for (let i = 0; i < 12; i++) keyPage.set(0x68 + i, `F${i + 13}`); // F13–F24
const KEY_NAMES: ReadonlyArray<readonly [number, string]> = [
  [0x28, 'Enter'],
  [0x29, 'Esc'],
  [0x2a, 'Bksp'],
  [0x2b, 'Tab'],
  [0x2c, 'Space'],
  [0x2d, '-'],
  [0x2e, '='],
  [0x2f, '['],
  [0x30, ']'],
  [0x31, '\\'],
  [0x33, ';'],
  [0x34, "'"],
  [0x35, '`'],
  [0x36, ','],
  [0x37, '.'],
  [0x38, '/'],
  [0x39, 'Caps'],
  [0x46, 'PrtSc'],
  [0x47, 'ScrLk'],
  [0x48, 'Pause'],
  [0x49, 'Ins'],
  [0x4a, 'Home'],
  [0x4b, 'PgUp'],
  [0x4c, 'Del'],
  [0x4d, 'End'],
  [0x4e, 'PgDn'],
  [0x4f, '→'],
  [0x50, '←'],
  [0x51, '↓'],
  [0x52, '↑'],
  [0x53, 'NumLk'],
  [0xe0, 'Ctrl'],
  [0xe1, 'Shift'],
  [0xe2, 'Alt'],
  [0xe3, 'Cmd'],
  [0xe4, 'RCtrl'],
  [0xe5, 'RShift'],
  [0xe6, 'RAlt'],
  [0xe7, 'RCmd'],
];
for (const [id, name] of KEY_NAMES) keyPage.set(id, name);

// Shifted-symbol display (US): when a key is Shift+<base> we show the
// produced glyph instead of "Shift+N1" etc. Keyed by base usage id.
const SHIFTED = new Map<number, string>([
  [0x1e, '!'],
  [0x1f, '@'],
  [0x20, '#'],
  [0x21, '$'],
  [0x22, '%'],
  [0x23, '^'],
  [0x24, '&'],
  [0x25, '*'],
  [0x26, '('],
  [0x27, ')'],
  [0x2d, '_'],
  [0x2e, '+'],
  [0x2f, '{'],
  [0x30, '}'],
  [0x31, '|'],
  [0x33, ':'],
  [0x34, '"'],
  [0x35, '~'],
  [0x36, '<'],
  [0x37, '>'],
  [0x38, '?'],
]);

// --- consumer page (0x0C) labels (the media keys kobu uses + common ones) ---
const consumerPage = new Map<number, string>([
  [0xb5, 'Next'],
  [0xb6, 'Prev'],
  [0xb7, 'Stop'],
  [0xcd, 'Play'],
  [0xe2, 'Mute'],
  [0xe9, 'Vol+'],
  [0xea, 'Vol-'],
  [0x6f, 'Bri+'],
  [0x70, 'Bri-'],
]);

function prefixMods(mods: number, base: string): string {
  const m = modsLabel(mods);
  return m ? `${m}+${base}` : base;
}

/** Human label for a `&kp`-style HID usage value (`param1`). */
export function keycodeLabel(param: number): string {
  if (param === 0) return '';
  const { mods, page, id } = decodeKeycode(param);
  if (page === HID_USAGE_CONSUMER) {
    const c = consumerPage.get(id);
    return prefixMods(mods, c ?? `C:0x${id.toString(16)}`);
  }
  // Shift-only over a known shifted symbol → show the glyph.
  if (mods === MOD_LSFT) {
    const sym = SHIFTED.get(id);
    if (sym) return sym;
  }
  const base = keyPage.get(id) ?? `0x${id.toString(16)}`;
  return prefixMods(mods, base);
}

export interface KeycodeOption {
  usage: number;
  label: string;
  group: string;
}

function buildPalette(): KeycodeOption[] {
  const out: KeycodeOption[] = [];
  const add = (page: number, id: number, label: string, group: string) =>
    out.push({ usage: encodeKeycode(page, id), label, group });

  for (let i = 0; i < 26; i++) add(HID_USAGE_KEY, 0x04 + i, String.fromCharCode(65 + i), '英字');
  for (let i = 0; i < 9; i++) add(HID_USAGE_KEY, 0x1e + i, String(i + 1), '数字');
  add(HID_USAGE_KEY, 0x27, '0', '数字');
  for (const [id, label] of KEY_NAMES) {
    if (id >= 0xe0) add(HID_USAGE_KEY, id, label, '修飾キー');
    else if (id >= 0x4a && id <= 0x52) add(HID_USAGE_KEY, id, label, 'ナビゲーション');
    else if (id >= 0x3a) add(HID_USAGE_KEY, id, label, 'その他');
    else add(HID_USAGE_KEY, id, label, '記号・編集');
  }
  for (let i = 0; i < 12; i++) add(HID_USAGE_KEY, 0x3a + i, `F${i + 1}`, 'ファンクション');
  for (const [id, label] of consumerPage) add(HID_USAGE_CONSUMER, id, label, 'メディア');
  return out;
}

/** Searchable palette of common keycodes for the binding picker. */
export const KEYCODE_PALETTE: KeycodeOption[] = buildPalette();
