import { describe, expect, it } from 'vitest';
import { changedCount, SETTING_DEFAULTS, toOverrides } from './settings';

describe('toOverrides', () => {
  it('is empty when nothing changed', () => {
    expect(toOverrides({ ...SETTING_DEFAULTS })).toEqual({});
    expect(changedCount({ ...SETTING_DEFAULTS })).toBe(0);
  });

  it('emits only changed knobs', () => {
    const values = { ...SETTING_DEFAULTS, left_cpi: 800 };
    expect(toOverrides(values)).toEqual({ left_cpi: 800 });
    expect(changedCount(values)).toBe(1);
  });

  it('converts pointer gain to an x100 integer', () => {
    const values = { ...SETTING_DEFAULTS, pointer_gain: 2 };
    expect(toOverrides(values)).toEqual({ pointer_gain_x100: 200 });
  });

  it('rounds non-gain values to integers', () => {
    const values = { ...SETTING_DEFAULTS, tapping_term_ms: 183.4 };
    expect(toOverrides(values)).toEqual({ tapping_term_ms: 183 });
  });
});
