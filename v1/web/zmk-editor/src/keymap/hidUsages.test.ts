import { describe, expect, it } from 'vitest';
import {
  decodeKeycode,
  encodeKeycode,
  HID_USAGE_CONSUMER,
  HID_USAGE_KEY,
  KEYCODE_PALETTE,
  keycodeLabel,
  MOD_LCTL,
  MOD_LSFT,
  modsLabel,
} from './hidUsages';

describe('encode/decode', () => {
  it('round-trips page/id/mods', () => {
    const v = encodeKeycode(HID_USAGE_KEY, 0x04, MOD_LCTL);
    expect(decodeKeycode(v)).toEqual({ mods: MOD_LCTL, page: HID_USAGE_KEY, id: 0x04 });
  });

  it('keeps the value unsigned with the top mod bit set', () => {
    const v = encodeKeycode(HID_USAGE_KEY, 0x04, 0x80);
    expect(v).toBeGreaterThan(0);
    expect(decodeKeycode(v).mods).toBe(0x80);
  });
});

describe('keycodeLabel', () => {
  it('labels a plain letter', () => {
    expect(keycodeLabel(encodeKeycode(HID_USAGE_KEY, 0x04))).toBe('A');
  });

  it('labels a modified key', () => {
    expect(keycodeLabel(encodeKeycode(HID_USAGE_KEY, 0x04, MOD_LCTL))).toBe('Ctrl+A');
  });

  it('shows the shifted glyph for Shift+number', () => {
    // 0x1e = "1"; Shift+1 = "!"
    expect(keycodeLabel(encodeKeycode(HID_USAGE_KEY, 0x1e, MOD_LSFT))).toBe('!');
  });

  it('labels a consumer (media) usage', () => {
    expect(keycodeLabel(encodeKeycode(HID_USAGE_CONSUMER, 0xe9))).toBe('Vol+');
  });

  it('returns empty for 0', () => {
    expect(keycodeLabel(0)).toBe('');
  });

  it('falls back to hex for unknown ids', () => {
    expect(keycodeLabel(encodeKeycode(HID_USAGE_KEY, 0x4242))).toBe('0x4242');
  });
});

describe('modsLabel', () => {
  it('joins active modifiers', () => {
    expect(modsLabel(MOD_LCTL | MOD_LSFT)).toBe('Ctrl+Shift');
    expect(modsLabel(0)).toBe('');
  });
});

describe('KEYCODE_PALETTE', () => {
  it('includes A–Z and media', () => {
    expect(KEYCODE_PALETTE.some((o) => o.label === 'A' && o.group === '英字')).toBe(true);
    expect(KEYCODE_PALETTE.some((o) => o.label === 'Vol+')).toBe(true);
  });
});
