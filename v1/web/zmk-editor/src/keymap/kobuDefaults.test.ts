import { describe, expect, it } from 'vitest';
import { formatDtBinding, KOBU_DEFAULT_LAYERS } from './kobuDefaults';

describe('KOBU_DEFAULT_LAYERS', () => {
  it('has 7 layers of 40 bindings each', () => {
    expect(KOBU_DEFAULT_LAYERS).toHaveLength(7);
    for (const layer of KOBU_DEFAULT_LAYERS) {
      expect(layer.bindings).toHaveLength(40);
    }
  });
});

describe('formatDtBinding', () => {
  it.each([
    ['&kp Q', 'Q'],
    ['&trans', '▽'],
    ['&none', ''],
    ['&klt 2 SPACE', 'L2/SPACE'],
    ['&kmt LGUI BSPC', 'LGUI/BSPC'],
    ['&mo 3', 'MO3'],
    ['&tog 6', 'TOG6'],
    ['&to 0', 'TO0'],
    ['&mkp MB1', 'MB1'],
    ['&bt BT_SEL 0', 'BT0'],
    ['&ht_cmd_shift_colon 0 0', 'Cmd+Shift / :'],
  ])('formats %s → %s', (input, expected) => {
    expect(formatDtBinding(input)).toBe(expected);
  });
});
