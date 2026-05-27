import { describe, expect, it } from 'vitest';
import type { KeyboardLayoutDef } from './handshake';
import {
  BASE_CATALOGUE,
  buildModBits,
  decodeKeycode,
  encodeDF,
  encodeLM,
  encodeLT,
  encodeMO,
  encodeMT,
  encodeOSL,
  encodeOSM,
  encodeTG,
  encodeTO,
  encodeTransparent,
  encodeWM,
  labelForKeycode,
  MOD_CTRL,
  MOD_RIGHT,
  MOD_SHIFT,
  searchCatalogue,
  userCatalogue,
} from './keycodes';

describe('decodeKeycode', () => {
  it('recognises No and Transparent', () => {
    expect(decodeKeycode(0x0000)).toEqual({ kind: 'no' });
    expect(decodeKeycode(0x0001)).toEqual({ kind: 'transparent' });
  });

  it('decodes basic keycodes from the catalogue', () => {
    const a = decodeKeycode(0x04);
    expect(a.kind).toBe('basic');
    if (a.kind === 'basic') expect(a.meta.name).toBe('A');
  });

  it('matches the RMK firmware encodings for layer + mod helpers', () => {
    // Mirrors the assertions in rmk-0.8.2/src/host/via/keycode_convert.rs::test
    expect(decodeKeycode(0x5223)).toEqual({ kind: 'mo', layer: 3 });
    expect(decodeKeycode(0x5283)).toEqual({ kind: 'osl', layer: 3 });
    expect(decodeKeycode(0x52b1)).toEqual({ kind: 'osm', mod: MOD_RIGHT | MOD_CTRL });
    expect(decodeKeycode(0x104)).toEqual({ kind: 'wm', kc: 0x04, mod: MOD_CTRL });
    expect(decodeKeycode(0x4304)).toEqual({ kind: 'lt', layer: 3, kc: 0x04 });
    expect(decodeKeycode(0x2604)).toEqual({
      kind: 'mt',
      kc: 0x04,
      mod: MOD_SHIFT | 0x04 /* LAlt */,
    });
    expect(decodeKeycode(0x5022)).toEqual({ kind: 'lm', layer: 1, mod: 0x02 });
  });

  it('decodes morse / macro / user ranges', () => {
    expect(decodeKeycode(0x5700)).toEqual({ kind: 'morse', index: 0 });
    expect(decodeKeycode(0x57ff)).toEqual({ kind: 'morse', index: 0xff });
    expect(decodeKeycode(0x7700)).toEqual({ kind: 'macro', index: 0 });
    expect(decodeKeycode(0x7e02)).toEqual({ kind: 'user', index: 2 });
  });
});

describe('encoders round-trip via the decoder', () => {
  it('round-trips MO / TO / TG / DF / OSL', () => {
    for (const layer of [0, 3, 6, 15]) {
      expect(decodeKeycode(encodeMO(layer))).toEqual({ kind: 'mo', layer });
      expect(decodeKeycode(encodeTO(layer))).toEqual({ kind: 'to', layer });
      expect(decodeKeycode(encodeTG(layer))).toEqual({ kind: 'tg', layer });
      expect(decodeKeycode(encodeDF(layer))).toEqual({ kind: 'df', layer });
      expect(decodeKeycode(encodeOSL(layer))).toEqual({ kind: 'osl', layer });
    }
  });

  it('round-trips OSM, LM, LT, MT, WM', () => {
    const mod = buildModBits({ shift: true, gui: true });
    expect(decodeKeycode(encodeOSM(mod))).toEqual({ kind: 'osm', mod });
    expect(decodeKeycode(encodeLM(2, mod))).toEqual({ kind: 'lm', layer: 2, mod });
    expect(decodeKeycode(encodeLT(2, 0x04))).toEqual({ kind: 'lt', layer: 2, kc: 0x04 });
    expect(decodeKeycode(encodeMT(0x04, mod))).toEqual({ kind: 'mt', kc: 0x04, mod });
    expect(decodeKeycode(encodeWM(0x04, mod))).toEqual({ kind: 'wm', kc: 0x04, mod });
  });

  it('round-trips Transparent', () => {
    expect(decodeKeycode(encodeTransparent())).toEqual({ kind: 'transparent' });
  });
});

describe('labelForKeycode', () => {
  it('returns a short letter label for basic keys', () => {
    expect(labelForKeycode(0x04)).toMatchObject({
      short: 'A',
      center: 'A',
      top: '',
      tone: 'normal',
      accent: 'none',
    });
  });

  it('splits MT into a centred tap label and a top hold-badge', () => {
    const mt = labelForKeycode(encodeMT(0x04, MOD_CTRL));
    expect(mt.center).toBe('A');
    expect(mt.top).toBe('LC');
    expect(mt.accent).toBe('tap-hold');
    expect(mt.long).toContain('MT(');
    // short still useful for callers (combo / macro rows)
    expect(mt.short).toContain('LC');
    expect(mt.short).toContain('A');
  });

  it('splits LT into tap-key centre and L<n> top-badge', () => {
    const lt = labelForKeycode(encodeLT(3, 0x04));
    expect(lt.center).toBe('A');
    expect(lt.top).toBe('L3');
    expect(lt.accent).toBe('tap-hold');
    expect(lt.short).toBe('L3/A');
  });

  it('splits WM into centred key and modifier badge', () => {
    const wm = labelForKeycode(encodeWM(0x04, MOD_SHIFT));
    expect(wm.center).toBe('A');
    expect(wm.top).toBe('LS');
    expect(wm.accent).toBe('mod');
    expect(wm.long).toContain('LS+');
  });

  it('renders kobu customKeycode labels when a definition is provided', () => {
    const definition: KeyboardLayoutDef = {
      matrix: { rows: 4, cols: 10 },
      layouts: { keymap: [] },
      customKeycodes: [
        { name: 'BT0', title: 'Bluetooth Channel 0', shortName: 'BT0' },
        { name: 'NEXT_BT', title: 'Next BT', shortName: 'Next\nBT' },
      ],
    };
    const u0 = labelForKeycode(0x7e00, { definition });
    expect(u0.short).toBe('BT0');
    expect(u0.center).toBe('BT0');
    expect(u0.tone).toBe('user');

    const u1 = labelForKeycode(0x7e01, { definition });
    // multi-line shortName splits into center + bottom on the keycap
    expect(u1.center).toBe('Next');
    expect(u1.bottom).toBe('BT');

    const u4 = labelForKeycode(0x7e04, { definition });
    expect(u4.short).toBe('U4');
    expect(u4.center).toBe('U4');
  });

  it('renders TG and MO labels with the layer number and a kind badge', () => {
    const mo = labelForKeycode(encodeMO(2));
    expect(mo.center).toBe('L2');
    expect(mo.top).toBe('MO');
    expect(mo.short).toBe('MO2');

    const tg = labelForKeycode(encodeTG(1));
    expect(tg.center).toBe('L1');
    expect(tg.top).toBe('TG');
  });

  it('falls back to a raw hex label for unknown ranges', () => {
    const label = labelForKeycode(0x6abc);
    expect(label.long).toBe('未対応 0x6abc');
    expect(label.center).toBe('?');
    expect(label.bottom).toBe('0x6abc');
  });
});

describe('userCatalogue', () => {
  it('merges definition customKeycodes into the picker entries', () => {
    const definition: KeyboardLayoutDef = {
      matrix: { rows: 4, cols: 10 },
      layouts: { keymap: [] },
      customKeycodes: [
        { name: 'BT0', title: 'Bluetooth Channel 0', shortName: 'BT0' },
        { name: 'BT1', title: 'Bluetooth Channel 1', shortName: 'BT1' },
      ],
    };
    const cat = userCatalogue(definition);
    expect(cat).toHaveLength(16);
    expect(cat[0]).toMatchObject({ code: 0x7e00, name: 'BT0', shortLabel: 'BT0' });
    expect(cat[1]).toMatchObject({ code: 0x7e01, name: 'BT1' });
    expect(cat[2]?.name).toBe('User2');
  });
});

describe('searchCatalogue', () => {
  it('finds keys by name prefix', () => {
    const hits = searchCatalogue(BASE_CATALOGUE, 'space');
    expect(hits[0]?.meta.name).toBe('Space');
  });

  it('matches across description and aliases', () => {
    const hits = searchCatalogue(BASE_CATALOGUE, 'arrow');
    const names = hits.map((h) => h.meta.name);
    expect(names).toContain('Up');
    expect(names).toContain('Down');
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchCatalogue(BASE_CATALOGUE, 'zzzzzz')).toEqual([]);
  });
});
