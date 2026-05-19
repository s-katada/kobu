/**
 * Keycode catalogue + Via wire-format encoder/decoder.
 *
 * The on-the-wire keycode for `DynamicKeymapGetBuffer` / `SetKeyCode` is
 * the QMK Via 16-bit value. RMK's `host/via/keycode_convert.rs` is the
 * authoritative reference for kobu's firmware — every encoding range
 * below maps 1:1 to a branch in that file.
 *
 * Layout of the address space (relevant subset only):
 *   0x0000          No
 *   0x0001          Transparent
 *   0x0002..0x00FF  base HID keycodes + media / system / mouse / mods
 *   0x0100..0x1FFF  KeyWithModifier (WM)            modifier << 8 | kc
 *   0x2000..0x3FFF  ModTap (MT)                     0x2000 | mod << 8 | kc
 *   0x4000..0x4FFF  LayerTap (LT)                   0x4000 | layer<<8 | kc
 *   0x5000..0x51FF  LayerOnWithModifier (LM)        0x5000 | layer<<5 | mod
 *   0x5200..0x521F  LayerToggleOnly (TO)
 *   0x5220..0x523F  LayerOn / Momentary (MO)
 *   0x5240..0x525F  DefaultLayer (DF)
 *   0x5260..0x527F  LayerToggle (TG)
 *   0x5280..0x529F  OneShotLayer (OSL)
 *   0x52A0..0x52BF  OneShotModifier (OSM)
 *   0x5700..0x57FF  Tap-dance / morse
 *   0x7700..0x771F  Macro N
 *   0x7C00..0x7C5F  RMK extras (Bootloader, Reboot, GraveEscape, ...)
 *   0x7E00..0x7E0F  User N (= kobu customKeycodes via vial.json)
 *
 * The modifier "packed bits" byte (used by WM/MT/OSM/LM) is:
 *   bit0=Ctrl, bit1=Shift, bit2=Alt, bit3=GUI, bit4=right-side flag
 * Left and right cannot both be set; left wins per
 * `rmk-types-0.2.2/src/modifier.rs::into_packed_bits`.
 */

import type { KeyboardLayoutDef } from './handshake';

// ─── Modifier helpers ─────────────────────────────────────────────────────

export const MOD_CTRL = 0x01;
export const MOD_SHIFT = 0x02;
export const MOD_ALT = 0x04;
export const MOD_GUI = 0x08;
export const MOD_RIGHT = 0x10;

/** Render a packed-bits modifier byte as e.g. "LCS" or "RG". */
export function formatModifiers(packed: number): string {
  if (packed === 0) return '';
  const right = (packed & MOD_RIGHT) !== 0;
  const parts: string[] = [];
  if (packed & MOD_CTRL) parts.push('C');
  if (packed & MOD_SHIFT) parts.push('S');
  if (packed & MOD_ALT) parts.push('A');
  if (packed & MOD_GUI) parts.push('G');
  return (right ? 'R' : 'L') + parts.join('');
}

// ─── Constants for compound keycode ranges ────────────────────────────────

export const KC_NO = 0x0000;
export const KC_TRANSPARENT = 0x0001;

export const WM_BASE = 0x0100;
export const MT_BASE = 0x2000;
export const LT_BASE = 0x4000;
export const LM_BASE = 0x5000;
export const TO_BASE = 0x5200;
export const MO_BASE = 0x5220;
export const DF_BASE = 0x5240;
export const TG_BASE = 0x5260;
export const OSL_BASE = 0x5280;
export const OSM_BASE = 0x52a0;
export const MORSE_BASE = 0x5700;
export const MACRO_BASE = 0x7700;
export const USER_BASE = 0x7e00;

// ─── Category catalogue ───────────────────────────────────────────────────

export type Category =
  | 'basic'
  | 'modifier'
  | 'special'
  | 'function'
  | 'media'
  | 'system'
  | 'mouse'
  | 'layer'
  | 'macro'
  | 'user'
  | 'other';

export interface KeycodeMeta {
  /** Via wire value. */
  code: number;
  /** Stable canonical identifier (matches QMK / RMK names). */
  name: string;
  /** Short label suitable for an SVG key cell (<=4 characters ideally). */
  shortLabel: string;
  /** Human-friendly long label for picker grid + tooltip. */
  label: string;
  /** Picker tooltip text. */
  description: string;
  category: Category;
  /** Extra fuzzy-match tokens for search. */
  aliases?: string[];
}

const BASIC_LETTERS: KeycodeMeta[] = Array.from({ length: 26 }, (_, i) => {
  const letter = String.fromCharCode(0x41 + i);
  return {
    code: 0x04 + i,
    name: letter,
    shortLabel: letter,
    label: letter,
    description: `アルファベット ${letter}`,
    category: 'basic' as Category,
  };
});

const BASIC_NUMBERS: KeycodeMeta[] = Array.from({ length: 10 }, (_, i) => {
  const digit = ((i + 1) % 10).toString();
  const shifted = [')', '!', '@', '#', '$', '%', '^', '&', '*', '('][
    digit === '0' ? 0 : Number(digit)
  ];
  return {
    code: 0x1e + i,
    name: `Kc${digit}`,
    shortLabel: digit,
    label: digit,
    description: `${digit} / ${shifted}`,
    category: 'basic' as Category,
    aliases: [`数字 ${digit}`, `number ${digit}`, `digit ${digit}`],
  };
});

const BASIC_PUNCT: KeycodeMeta[] = [
  {
    code: 0x2d,
    name: 'Minus',
    shortLabel: '-',
    label: 'マイナス',
    description: '- / _',
    category: 'basic',
    aliases: ['minus', 'hyphen'],
  },
  {
    code: 0x2e,
    name: 'Equal',
    shortLabel: '=',
    label: 'イコール',
    description: '= / +',
    category: 'basic',
    aliases: ['equal', 'plus'],
  },
  {
    code: 0x2f,
    name: 'LeftBracket',
    shortLabel: '[',
    label: '左ブラケット',
    description: '[ / {',
    category: 'basic',
    aliases: ['bracket'],
  },
  {
    code: 0x30,
    name: 'RightBracket',
    shortLabel: ']',
    label: '右ブラケット',
    description: '] / }',
    category: 'basic',
    aliases: ['bracket'],
  },
  {
    code: 0x31,
    name: 'Backslash',
    shortLabel: '\\',
    label: 'バックスラッシュ',
    description: '\\ / |',
    category: 'basic',
    aliases: ['backslash', 'pipe'],
  },
  {
    code: 0x33,
    name: 'Semicolon',
    shortLabel: ';',
    label: 'セミコロン',
    description: '; / :',
    category: 'basic',
    aliases: ['semicolon', 'colon'],
  },
  {
    code: 0x34,
    name: 'Quote',
    shortLabel: "'",
    label: 'クォート',
    description: '\' / "',
    category: 'basic',
    aliases: ['quote'],
  },
  {
    code: 0x35,
    name: 'Grave',
    shortLabel: '`',
    label: 'グレイブ',
    description: '` / ~',
    category: 'basic',
    aliases: ['grave', 'tilde', 'backtick'],
  },
  {
    code: 0x36,
    name: 'Comma',
    shortLabel: ',',
    label: 'カンマ',
    description: ', / <',
    category: 'basic',
    aliases: ['comma'],
  },
  {
    code: 0x37,
    name: 'Dot',
    shortLabel: '.',
    label: 'ピリオド',
    description: '. / >',
    category: 'basic',
    aliases: ['dot', 'period'],
  },
  {
    code: 0x38,
    name: 'Slash',
    shortLabel: '/',
    label: 'スラッシュ',
    description: '/ / ?',
    category: 'basic',
    aliases: ['slash'],
  },
];

const SPECIAL: KeycodeMeta[] = [
  {
    code: 0x28,
    name: 'Enter',
    shortLabel: 'Ent',
    label: 'エンター',
    description: 'Enter / Return',
    category: 'special',
    aliases: ['enter', 'return'],
  },
  {
    code: 0x29,
    name: 'Escape',
    shortLabel: 'Esc',
    label: 'エスケープ',
    description: 'Escape',
    category: 'special',
    aliases: ['esc'],
  },
  {
    code: 0x2a,
    name: 'Backspace',
    shortLabel: 'BS',
    label: 'バックスペース',
    description: 'Backspace',
    category: 'special',
    aliases: ['bs', 'backspace'],
  },
  {
    code: 0x2b,
    name: 'Tab',
    shortLabel: 'Tab',
    label: 'タブ',
    description: 'Tab',
    category: 'special',
  },
  {
    code: 0x2c,
    name: 'Space',
    shortLabel: '␣',
    label: 'スペース',
    description: 'Space',
    category: 'special',
    aliases: ['space'],
  },
  {
    code: 0x39,
    name: 'CapsLock',
    shortLabel: 'Caps',
    label: 'Caps Lock',
    description: 'Caps Lock',
    category: 'special',
  },
  {
    code: 0x46,
    name: 'PrintScreen',
    shortLabel: 'PrSc',
    label: 'Print Screen',
    description: 'プリントスクリーン',
    category: 'special',
    aliases: ['print screen'],
  },
  {
    code: 0x47,
    name: 'ScrollLock',
    shortLabel: 'ScrLk',
    label: 'Scroll Lock',
    description: 'スクロールロック',
    category: 'special',
    aliases: ['scroll lock'],
  },
  {
    code: 0x48,
    name: 'Pause',
    shortLabel: 'Pse',
    label: 'Pause',
    description: 'ポーズ',
    category: 'special',
    aliases: ['pause'],
  },
  {
    code: 0x49,
    name: 'Insert',
    shortLabel: 'Ins',
    label: 'Insert',
    description: 'インサート',
    category: 'special',
    aliases: ['insert'],
  },
  {
    code: 0x4a,
    name: 'Home',
    shortLabel: 'Hom',
    label: 'Home',
    description: 'ホーム',
    category: 'special',
    aliases: ['home'],
  },
  {
    code: 0x4b,
    name: 'PageUp',
    shortLabel: 'PgU',
    label: 'Page Up',
    description: 'ページアップ',
    category: 'special',
    aliases: ['page up'],
  },
  {
    code: 0x4c,
    name: 'Delete',
    shortLabel: 'Del',
    label: 'Delete',
    description: 'デリート',
    category: 'special',
    aliases: ['delete', 'del'],
  },
  {
    code: 0x4d,
    name: 'End',
    shortLabel: 'End',
    label: 'End',
    description: 'エンド',
    category: 'special',
    aliases: ['end'],
  },
  {
    code: 0x4e,
    name: 'PageDown',
    shortLabel: 'PgD',
    label: 'Page Down',
    description: 'ページダウン',
    category: 'special',
    aliases: ['page down'],
  },
  {
    code: 0x4f,
    name: 'Right',
    shortLabel: '→',
    label: '右',
    description: '右矢印',
    category: 'special',
    aliases: ['right', 'arrow'],
  },
  {
    code: 0x50,
    name: 'Left',
    shortLabel: '←',
    label: '左',
    description: '左矢印',
    category: 'special',
    aliases: ['left', 'arrow'],
  },
  {
    code: 0x51,
    name: 'Down',
    shortLabel: '↓',
    label: '下',
    description: '下矢印',
    category: 'special',
    aliases: ['down', 'arrow'],
  },
  {
    code: 0x52,
    name: 'Up',
    shortLabel: '↑',
    label: '上',
    description: '上矢印',
    category: 'special',
    aliases: ['up', 'arrow'],
  },
  {
    code: 0x65,
    name: 'Application',
    shortLabel: 'App',
    label: 'Application',
    description: 'メニューキー',
    category: 'special',
    aliases: ['menu', 'app'],
  },
  {
    code: 0x87,
    name: 'International1',
    shortLabel: 'Intl1',
    label: 'International 1',
    description: 'Intl1（JIS \\_）',
    category: 'special',
    aliases: ['jis'],
  },
  {
    code: 0x88,
    name: 'International2',
    shortLabel: 'Intl2',
    label: 'International 2',
    description: 'Intl2（カタカナ／ひらがな）',
    category: 'special',
    aliases: ['katakana', 'hiragana'],
  },
  {
    code: 0x89,
    name: 'International3',
    shortLabel: 'Intl3',
    label: 'International 3',
    description: 'Intl3（JIS ¥）',
    category: 'special',
    aliases: ['jis', 'yen'],
  },
  {
    code: 0x8a,
    name: 'International4',
    shortLabel: 'Intl4',
    label: 'International 4',
    description: '変換キー',
    category: 'special',
    aliases: ['henkan'],
  },
  {
    code: 0x8b,
    name: 'International5',
    shortLabel: 'Intl5',
    label: 'International 5',
    description: '無変換キー',
    category: 'special',
    aliases: ['muhenkan'],
  },
  {
    code: 0x90,
    name: 'Language1',
    shortLabel: 'Lng1',
    label: 'Language 1',
    description: 'かな（macOS）',
    category: 'special',
    aliases: ['kana', 'macOS'],
  },
  {
    code: 0x91,
    name: 'Language2',
    shortLabel: 'Lng2',
    label: 'Language 2',
    description: '英数（macOS）',
    category: 'special',
    aliases: ['eisuu', 'eisu', 'macOS'],
  },
];

const FUNCTION_KEYS: KeycodeMeta[] = Array.from({ length: 12 }, (_, i) => ({
  code: 0x3a + i,
  name: `F${i + 1}`,
  shortLabel: `F${i + 1}`,
  label: `F${i + 1}`,
  description: `ファンクションキー F${i + 1}`,
  category: 'function' as Category,
})).concat(
  Array.from({ length: 12 }, (_, i) => ({
    code: 0x68 + i,
    name: `F${i + 13}`,
    shortLabel: `F${i + 13}`,
    label: `F${i + 13}`,
    description: `ファンクションキー F${i + 13}`,
    category: 'function' as Category,
  })),
);

const MODIFIERS: KeycodeMeta[] = [
  {
    code: 0xe0,
    name: 'LCtrl',
    shortLabel: 'LCtl',
    label: '左 Ctrl',
    description: '左 Control',
    category: 'modifier',
    aliases: ['ctrl', 'control'],
  },
  {
    code: 0xe1,
    name: 'LShift',
    shortLabel: 'LSft',
    label: '左 Shift',
    description: '左 Shift',
    category: 'modifier',
    aliases: ['shift'],
  },
  {
    code: 0xe2,
    name: 'LAlt',
    shortLabel: 'LAlt',
    label: '左 Alt',
    description: '左 Alt / Option',
    category: 'modifier',
    aliases: ['alt', 'option'],
  },
  {
    code: 0xe3,
    name: 'LGui',
    shortLabel: 'LGui',
    label: '左 GUI',
    description: '左 Command / Win',
    category: 'modifier',
    aliases: ['gui', 'cmd', 'command', 'win'],
  },
  {
    code: 0xe4,
    name: 'RCtrl',
    shortLabel: 'RCtl',
    label: '右 Ctrl',
    description: '右 Control',
    category: 'modifier',
    aliases: ['ctrl', 'control'],
  },
  {
    code: 0xe5,
    name: 'RShift',
    shortLabel: 'RSft',
    label: '右 Shift',
    description: '右 Shift',
    category: 'modifier',
    aliases: ['shift'],
  },
  {
    code: 0xe6,
    name: 'RAlt',
    shortLabel: 'RAlt',
    label: '右 Alt',
    description: '右 Alt / Option',
    category: 'modifier',
    aliases: ['alt', 'option'],
  },
  {
    code: 0xe7,
    name: 'RGui',
    shortLabel: 'RGui',
    label: '右 GUI',
    description: '右 Command / Win',
    category: 'modifier',
    aliases: ['gui', 'cmd', 'command', 'win'],
  },
];

const MEDIA: KeycodeMeta[] = [
  {
    code: 0xa8,
    name: 'AudioMute',
    shortLabel: 'Mute',
    label: 'ミュート',
    description: '音声ミュート',
    category: 'media',
    aliases: ['mute', 'volume'],
  },
  {
    code: 0xa9,
    name: 'AudioVolUp',
    shortLabel: 'Vol+',
    label: '音量アップ',
    description: '音量を上げる',
    category: 'media',
    aliases: ['volume up'],
  },
  {
    code: 0xaa,
    name: 'AudioVolDown',
    shortLabel: 'Vol-',
    label: '音量ダウン',
    description: '音量を下げる',
    category: 'media',
    aliases: ['volume down'],
  },
  {
    code: 0xab,
    name: 'MediaNextTrack',
    shortLabel: 'Next',
    label: '次の曲',
    description: '次のトラック',
    category: 'media',
    aliases: ['next track', 'media next'],
  },
  {
    code: 0xac,
    name: 'MediaPrevTrack',
    shortLabel: 'Prev',
    label: '前の曲',
    description: '前のトラック',
    category: 'media',
    aliases: ['previous track', 'media previous'],
  },
  {
    code: 0xad,
    name: 'MediaStop',
    shortLabel: 'Stop',
    label: '停止',
    description: 'メディア停止',
    category: 'media',
    aliases: ['stop'],
  },
  {
    code: 0xae,
    name: 'MediaPlayPause',
    shortLabel: 'Play',
    label: '再生 / 一時停止',
    description: 'メディア再生 / 一時停止',
    category: 'media',
    aliases: ['play', 'pause'],
  },
  {
    code: 0xaf,
    name: 'MediaSelect',
    shortLabel: 'MSel',
    label: 'メディア選択',
    description: 'メディア選択',
    category: 'media',
    aliases: ['media select'],
  },
  {
    code: 0xb0,
    name: 'MediaEject',
    shortLabel: 'Ejct',
    label: 'イジェクト',
    description: 'メディア取り出し',
    category: 'media',
    aliases: ['eject'],
  },
  {
    code: 0xbb,
    name: 'MediaFastForward',
    shortLabel: 'FF',
    label: '早送り',
    description: 'メディア早送り',
    category: 'media',
    aliases: ['fast forward'],
  },
  {
    code: 0xbc,
    name: 'MediaRewind',
    shortLabel: 'Rew',
    label: '巻き戻し',
    description: 'メディア巻き戻し',
    category: 'media',
    aliases: ['rewind'],
  },
  {
    code: 0xbd,
    name: 'BrightnessUp',
    shortLabel: 'Br+',
    label: '輝度アップ',
    description: 'ディスプレイ輝度を上げる',
    category: 'media',
    aliases: ['brightness up'],
  },
  {
    code: 0xbe,
    name: 'BrightnessDown',
    shortLabel: 'Br-',
    label: '輝度ダウン',
    description: 'ディスプレイ輝度を下げる',
    category: 'media',
    aliases: ['brightness down'],
  },
];

const SYSTEM: KeycodeMeta[] = [
  {
    code: 0xa5,
    name: 'SystemPower',
    shortLabel: 'Pwr',
    label: '電源',
    description: 'システム電源',
    category: 'system',
    aliases: ['power'],
  },
  {
    code: 0xa6,
    name: 'SystemSleep',
    shortLabel: 'Slp',
    label: 'スリープ',
    description: 'システムスリープ',
    category: 'system',
    aliases: ['sleep'],
  },
  {
    code: 0xa7,
    name: 'SystemWake',
    shortLabel: 'Wke',
    label: 'ウェイク',
    description: 'システムウェイク',
    category: 'system',
    aliases: ['wake'],
  },
  {
    code: 0xc1,
    name: 'MissionControl',
    shortLabel: 'Msn',
    label: 'Mission Control',
    description: 'macOS Mission Control',
    category: 'system',
    aliases: ['mission control'],
  },
  {
    code: 0xc2,
    name: 'Launchpad',
    shortLabel: 'Lpd',
    label: 'Launchpad',
    description: 'macOS Launchpad',
    category: 'system',
  },
];

const MOUSE: KeycodeMeta[] = [
  {
    code: 0xcd,
    name: 'MouseUp',
    shortLabel: 'M↑',
    label: 'マウス 上',
    description: 'マウスカーソルを上へ',
    category: 'mouse',
    aliases: ['mouse up'],
  },
  {
    code: 0xce,
    name: 'MouseDown',
    shortLabel: 'M↓',
    label: 'マウス 下',
    description: 'マウスカーソルを下へ',
    category: 'mouse',
    aliases: ['mouse down'],
  },
  {
    code: 0xcf,
    name: 'MouseLeft',
    shortLabel: 'M←',
    label: 'マウス 左',
    description: 'マウスカーソルを左へ',
    category: 'mouse',
    aliases: ['mouse left'],
  },
  {
    code: 0xd0,
    name: 'MouseRight',
    shortLabel: 'M→',
    label: 'マウス 右',
    description: 'マウスカーソルを右へ',
    category: 'mouse',
    aliases: ['mouse right'],
  },
  {
    code: 0xd1,
    name: 'MouseBtn1',
    shortLabel: 'MB1',
    label: 'マウスボタン 1',
    description: 'マウスボタン 1（左クリック）',
    category: 'mouse',
    aliases: ['mouse click', 'left click'],
  },
  {
    code: 0xd2,
    name: 'MouseBtn2',
    shortLabel: 'MB2',
    label: 'マウスボタン 2',
    description: 'マウスボタン 2（右クリック）',
    category: 'mouse',
    aliases: ['right click'],
  },
  {
    code: 0xd3,
    name: 'MouseBtn3',
    shortLabel: 'MB3',
    label: 'マウスボタン 3',
    description: 'マウスボタン 3（中クリック）',
    category: 'mouse',
    aliases: ['middle click'],
  },
  {
    code: 0xd4,
    name: 'MouseBtn4',
    shortLabel: 'MB4',
    label: 'マウスボタン 4',
    description: 'マウスボタン 4（戻る）',
    category: 'mouse',
    aliases: ['back'],
  },
  {
    code: 0xd5,
    name: 'MouseBtn5',
    shortLabel: 'MB5',
    label: 'マウスボタン 5',
    description: 'マウスボタン 5（進む）',
    category: 'mouse',
    aliases: ['forward'],
  },
  {
    code: 0xd9,
    name: 'MouseWheelUp',
    shortLabel: 'MW↑',
    label: 'ホイール 上',
    description: 'マウスホイールを上へ',
    category: 'mouse',
    aliases: ['wheel up', 'scroll up'],
  },
  {
    code: 0xda,
    name: 'MouseWheelDown',
    shortLabel: 'MW↓',
    label: 'ホイール 下',
    description: 'マウスホイールを下へ',
    category: 'mouse',
    aliases: ['wheel down', 'scroll down'],
  },
  {
    code: 0xdb,
    name: 'MouseWheelLeft',
    shortLabel: 'MW←',
    label: 'ホイール 左',
    description: 'マウスホイールを左へ',
    category: 'mouse',
    aliases: ['wheel left'],
  },
  {
    code: 0xdc,
    name: 'MouseWheelRight',
    shortLabel: 'MW→',
    label: 'ホイール 右',
    description: 'マウスホイールを右へ',
    category: 'mouse',
    aliases: ['wheel right'],
  },
];

const RMK_EXTRAS: KeycodeMeta[] = [
  {
    code: 0x7c00,
    name: 'Bootloader',
    shortLabel: 'Boot',
    label: 'ブートローダ',
    description: 'ブートローダ（DFU モード）へ移行',
    category: 'other',
    aliases: ['bootloader', 'dfu'],
  },
  {
    code: 0x7c01,
    name: 'Reboot',
    shortLabel: 'Rbt',
    label: '再起動',
    description: 'キーボードを再起動',
    category: 'other',
    aliases: ['reboot', 'reset'],
  },
  {
    code: 0x7c16,
    name: 'GraveEscape',
    shortLabel: 'GEsc',
    label: 'Grave/Escape',
    description: '単押しで Esc、修飾と組み合わせると `',
    category: 'other',
    aliases: ['grave', 'escape'],
  },
  {
    code: 0x7c50,
    name: 'ComboToggle',
    shortLabel: 'CmbT',
    label: 'コンボ切替',
    description: 'コンボのオン／オフを切り替え',
    category: 'other',
    aliases: ['combo'],
  },
  {
    code: 0x7c51,
    name: 'ComboOff',
    shortLabel: 'CmbX',
    label: 'コンボ無効',
    description: 'コンボを無効化',
    category: 'other',
    aliases: ['combo'],
  },
  {
    code: 0x7c52,
    name: 'ComboOn',
    shortLabel: 'CmbN',
    label: 'コンボ有効',
    description: 'コンボを有効化',
    category: 'other',
    aliases: ['combo'],
  },
  {
    code: 0x7c73,
    name: 'CapsWordToggle',
    shortLabel: 'CWd',
    label: 'Caps Word',
    description: 'Caps Word を切り替え',
    category: 'other',
    aliases: ['caps word'],
  },
  {
    code: 0x7c77,
    name: 'TriLayerLower',
    shortLabel: 'Tri↓',
    label: 'Tri Layer Lower',
    description: 'トライレイヤー（下）',
    category: 'other',
  },
  {
    code: 0x7c78,
    name: 'TriLayerUpper',
    shortLabel: 'Tri↑',
    label: 'Tri Layer Upper',
    description: 'トライレイヤー（上）',
    category: 'other',
  },
  {
    code: 0x7c79,
    name: 'RepeatKey',
    shortLabel: 'Rep',
    label: 'リピート',
    description: '直前のキーを繰り返す',
    category: 'other',
    aliases: ['repeat'],
  },
];

const NO_AND_TRANSPARENT: KeycodeMeta[] = [
  {
    code: 0x0000,
    name: 'No',
    shortLabel: '▫',
    label: 'なし',
    description: '何もしない（空のスロット）',
    category: 'other',
    aliases: ['no', 'none'],
  },
  {
    code: 0x0001,
    name: 'Transparent',
    shortLabel: '▽',
    label: '透過',
    description: '下のレイヤーへフォールスルー',
    category: 'other',
    aliases: ['trns', '_', 'transparent', '透明'],
  },
];

/** Full single-keycode catalogue. Compound encodings are handled by templates. */
export const BASE_CATALOGUE: readonly KeycodeMeta[] = Object.freeze([
  ...NO_AND_TRANSPARENT,
  ...BASIC_LETTERS,
  ...BASIC_NUMBERS,
  ...BASIC_PUNCT,
  ...SPECIAL,
  ...FUNCTION_KEYS,
  ...MODIFIERS,
  ...MEDIA,
  ...SYSTEM,
  ...MOUSE,
  ...RMK_EXTRAS,
]);

/** Macro keycodes (Macro0 .. Macro31 → Via 0x7700..0x771F). */
export const MACRO_CATALOGUE: readonly KeycodeMeta[] = Object.freeze(
  Array.from({ length: 32 }, (_, i) => ({
    code: MACRO_BASE + i,
    name: `Macro${i}`,
    shortLabel: `M${i}`,
    label: `マクロ ${i}`,
    description: `マクロ #${i} を実行`,
    category: 'macro' as Category,
  })),
);

/**
 * User catalogue. User0..User7 are kobu-defined customKeycodes and pick
 * up their labels from the firmware's `vial.json`. User8..User15 stay
 * generic until a future build registers more.
 */
export function userCatalogue(definition?: KeyboardLayoutDef): readonly KeycodeMeta[] {
  const custom = definition?.customKeycodes ?? [];
  return Object.freeze(
    Array.from({ length: 16 }, (_, i) => {
      const meta = custom[i];
      const name = meta?.name ?? `User${i}`;
      const short = (meta?.shortName ?? `U${i}`).replace(/\n/g, ' ');
      const long = meta?.title ?? `ユーザキーコード #${i}`;
      return {
        code: USER_BASE + i,
        name,
        shortLabel: short,
        label: name,
        description: long,
        category: 'user' as Category,
        aliases: meta ? [meta.title, `User${i}`] : [`User${i}`],
      };
    }),
  );
}

const BASE_BY_CODE = new Map<number, KeycodeMeta>(
  [...BASE_CATALOGUE, ...MACRO_CATALOGUE].map((m) => [m.code, m]),
);

/** Look up a flat (non-compound) keycode's metadata. */
export function lookupBase(code: number): KeycodeMeta | undefined {
  return BASE_BY_CODE.get(code);
}

// ─── Decoder ──────────────────────────────────────────────────────────────

export type DecodedKeycode =
  | { kind: 'no' }
  | { kind: 'transparent' }
  | { kind: 'basic'; meta: KeycodeMeta }
  | { kind: 'wm'; kc: number; mod: number }
  | { kind: 'mt'; kc: number; mod: number }
  | { kind: 'lt'; layer: number; kc: number }
  | { kind: 'lm'; layer: number; mod: number }
  | { kind: 'to'; layer: number }
  | { kind: 'mo'; layer: number }
  | { kind: 'df'; layer: number }
  | { kind: 'tg'; layer: number }
  | { kind: 'osl'; layer: number }
  | { kind: 'osm'; mod: number }
  | { kind: 'morse'; index: number }
  | { kind: 'macro'; index: number }
  | { kind: 'user'; index: number }
  | { kind: 'raw'; code: number };

export function decodeKeycode(code: number): DecodedKeycode {
  if (code === KC_NO) return { kind: 'no' };
  if (code === KC_TRANSPARENT) return { kind: 'transparent' };

  if (code >= 0x0002 && code <= 0x00ff) {
    const meta = BASE_BY_CODE.get(code);
    return meta ? { kind: 'basic', meta } : { kind: 'raw', code };
  }

  if (code >= WM_BASE && code <= 0x1fff) {
    return { kind: 'wm', kc: code & 0xff, mod: (code >> 8) & 0x1f };
  }
  if (code >= MT_BASE && code <= 0x3fff) {
    return { kind: 'mt', kc: code & 0xff, mod: (code >> 8) & 0x1f };
  }
  if (code >= LT_BASE && code <= 0x4fff) {
    return { kind: 'lt', layer: (code >> 8) & 0xf, kc: code & 0xff };
  }
  if (code >= LM_BASE && code <= 0x51ff) {
    return { kind: 'lm', layer: (code >> 5) & 0xf, mod: code & 0x1f };
  }
  if (code >= TO_BASE && code <= 0x521f) return { kind: 'to', layer: code & 0x0f };
  if (code >= MO_BASE && code <= 0x523f) return { kind: 'mo', layer: code & 0x0f };
  if (code >= DF_BASE && code <= 0x525f) return { kind: 'df', layer: code & 0x0f };
  if (code >= TG_BASE && code <= 0x527f) return { kind: 'tg', layer: code & 0x0f };
  if (code >= OSL_BASE && code <= 0x529f) return { kind: 'osl', layer: code & 0x0f };
  if (code >= OSM_BASE && code <= 0x52bf) return { kind: 'osm', mod: code & 0x1f };

  if (code >= MORSE_BASE && code <= 0x57ff) return { kind: 'morse', index: code & 0xff };
  if (code >= MACRO_BASE && code <= 0x771f) return { kind: 'macro', index: code & 0x1f };
  if (code >= USER_BASE && code <= 0x7e0f) return { kind: 'user', index: code & 0x0f };

  // RMK extras range — try metadata, fall back to raw.
  const meta = BASE_BY_CODE.get(code);
  if (meta) return { kind: 'basic', meta };
  return { kind: 'raw', code };
}

// ─── Label resolver ───────────────────────────────────────────────────────

export interface LabelOptions {
  /** kobu customKeycodes used to humanise User0..User7. */
  definition?: KeyboardLayoutDef;
}

export interface KeyLabel {
  /** Short label suitable for a 4×10 SVG cell. */
  short: string;
  /** Longer label for the picker / tooltip. */
  long: string;
  /** Cell tint hint — used by the SVG renderer. */
  tone: 'normal' | 'muted' | 'layer' | 'mod' | 'user' | 'mouse' | 'media' | 'other';
}

export function labelForKeycode(code: number, options: LabelOptions = {}): KeyLabel {
  const decoded = decodeKeycode(code);
  switch (decoded.kind) {
    case 'no':
      return { short: '', long: 'なし', tone: 'muted' };
    case 'transparent':
      return { short: '▽', long: '透過', tone: 'muted' };
    case 'basic': {
      const meta = decoded.meta;
      const tone = toneForCategory(meta.category);
      return { short: meta.shortLabel, long: meta.label, tone };
    }
    case 'wm': {
      const inner = lookupBase(decoded.kc);
      const innerLabel = inner?.shortLabel ?? `0x${decoded.kc.toString(16)}`;
      const mod = formatModifiers(decoded.mod);
      return {
        short: `${mod}+${innerLabel}`,
        long: `${mod}+${inner?.label ?? innerLabel}`,
        tone: 'mod',
      };
    }
    case 'mt': {
      const inner = lookupBase(decoded.kc);
      const innerLabel = inner?.shortLabel ?? `0x${decoded.kc.toString(16)}`;
      const mod = formatModifiers(decoded.mod);
      return {
        short: `${mod}/${innerLabel}`,
        long: `MT(${inner?.label ?? innerLabel}, ${mod})`,
        tone: 'mod',
      };
    }
    case 'lt': {
      const inner = lookupBase(decoded.kc);
      const innerLabel = inner?.shortLabel ?? `0x${decoded.kc.toString(16)}`;
      return {
        short: `L${decoded.layer}/${innerLabel}`,
        long: `LT(${decoded.layer}, ${inner?.label ?? innerLabel})`,
        tone: 'layer',
      };
    }
    case 'lm':
      return {
        short: `L${decoded.layer}+${formatModifiers(decoded.mod)}`,
        long: `LM(${decoded.layer}, ${formatModifiers(decoded.mod)})`,
        tone: 'layer',
      };
    case 'to':
      return { short: `TO${decoded.layer}`, long: `TO(${decoded.layer})`, tone: 'layer' };
    case 'mo':
      return { short: `MO${decoded.layer}`, long: `MO(${decoded.layer})`, tone: 'layer' };
    case 'df':
      return { short: `DF${decoded.layer}`, long: `DF(${decoded.layer})`, tone: 'layer' };
    case 'tg':
      return { short: `TG${decoded.layer}`, long: `TG(${decoded.layer})`, tone: 'layer' };
    case 'osl':
      return { short: `OSL${decoded.layer}`, long: `OSL(${decoded.layer})`, tone: 'layer' };
    case 'osm': {
      const mod = formatModifiers(decoded.mod);
      return { short: `OSM ${mod}`, long: `OSM(${mod})`, tone: 'mod' };
    }
    case 'morse':
      return { short: `TD${decoded.index}`, long: `TD(${decoded.index})`, tone: 'other' };
    case 'macro':
      return { short: `M${decoded.index}`, long: `マクロ ${decoded.index}`, tone: 'other' };
    case 'user': {
      const custom = options.definition?.customKeycodes?.[decoded.index];
      const short = (custom?.shortName ?? `U${decoded.index}`).replace(/\n/g, ' ');
      const long = custom?.name ?? `User${decoded.index}`;
      return { short, long, tone: 'user' };
    }
    case 'raw':
      return {
        short: `?${decoded.code.toString(16)}`,
        long: `未対応 0x${decoded.code.toString(16).padStart(4, '0')}`,
        tone: 'other',
      };
  }
}

function toneForCategory(category: Category): KeyLabel['tone'] {
  switch (category) {
    case 'modifier':
      return 'mod';
    case 'media':
      return 'media';
    case 'mouse':
      return 'mouse';
    case 'user':
      return 'user';
    case 'macro':
    case 'other':
      return 'other';
    case 'layer':
      return 'layer';
    default:
      return 'normal';
  }
}

// ─── Encoder (parametric template builders) ───────────────────────────────

/**
 * Pack a modifier set into the Via "packed bits" byte. `MOD_RIGHT`
 * indicates the right-side variant; left/right cannot mix.
 */
export function buildModBits(opts: {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  gui?: boolean;
  right?: boolean;
}): number {
  let bits = 0;
  if (opts.ctrl) bits |= MOD_CTRL;
  if (opts.shift) bits |= MOD_SHIFT;
  if (opts.alt) bits |= MOD_ALT;
  if (opts.gui) bits |= MOD_GUI;
  if (opts.right) bits |= MOD_RIGHT;
  return bits & 0x1f;
}

export function encodeNo(): number {
  return KC_NO;
}
export function encodeTransparent(): number {
  return KC_TRANSPARENT;
}
export function encodeMO(layer: number): number {
  return MO_BASE | (layer & 0x0f);
}
export function encodeTO(layer: number): number {
  return TO_BASE | (layer & 0x0f);
}
export function encodeTG(layer: number): number {
  return TG_BASE | (layer & 0x0f);
}
export function encodeDF(layer: number): number {
  return DF_BASE | (layer & 0x0f);
}
export function encodeOSL(layer: number): number {
  return OSL_BASE | (layer & 0x0f);
}
export function encodeOSM(mod: number): number {
  return OSM_BASE | (mod & 0x1f);
}
export function encodeLT(layer: number, kc: number): number {
  return LT_BASE | ((layer & 0x0f) << 8) | (kc & 0xff);
}
export function encodeMT(kc: number, mod: number): number {
  return MT_BASE | ((mod & 0x1f) << 8) | (kc & 0xff);
}
export function encodeWM(kc: number, mod: number): number {
  return ((mod & 0x1f) << 8) | (kc & 0xff);
}
export function encodeLM(layer: number, mod: number): number {
  return LM_BASE | ((layer & 0x0f) << 5) | (mod & 0x1f);
}

// ─── Search index ─────────────────────────────────────────────────────────

export interface SearchHit {
  meta: KeycodeMeta;
  /** Lower is better. */
  score: number;
}

/** Naive case-insensitive scoring: prefix match wins, then includes. */
export function searchCatalogue(
  catalogue: readonly KeycodeMeta[],
  query: string,
  limit = 40,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return catalogue.slice(0, limit).map((meta) => ({ meta, score: 0 }));
  }
  const hits: SearchHit[] = [];
  for (const meta of catalogue) {
    const haystacks = [
      meta.name,
      meta.shortLabel,
      meta.label,
      meta.description,
      ...(meta.aliases ?? []),
    ];
    let best = Infinity;
    for (const h of haystacks) {
      const lc = h.toLowerCase();
      if (lc === q) {
        best = Math.min(best, 0);
      } else if (lc.startsWith(q)) {
        best = Math.min(best, 1);
      } else if (lc.includes(q)) {
        best = Math.min(best, 2);
      }
    }
    if (best !== Infinity) hits.push({ meta, score: best });
  }
  hits.sort((a, b) => a.score - b.score || a.meta.name.localeCompare(b.meta.name));
  return hits.slice(0, limit);
}
