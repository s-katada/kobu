import { describe, expect, it } from 'vitest';
import type { GetBehaviorDetailsResponse } from '../rpc/types';
import { formatBinding } from './binding';
import { encodeKeycode, HID_USAGE_KEY } from './hidUsages';

const layerName = (i: number) => `L${i}`;

const kp: GetBehaviorDetailsResponse = {
  id: 1,
  displayName: 'Key Press',
  metadata: [
    { param1: [{ name: 'key', hidUsage: { keyboardMax: 0xff, consumerMax: 0xff } }], param2: [] },
  ],
};

const layerTap: GetBehaviorDetailsResponse = {
  id: 2,
  displayName: 'Layer Tap',
  metadata: [
    {
      param1: [{ name: 'layer', layerId: {} }],
      param2: [{ name: 'key', hidUsage: { keyboardMax: 0xff, consumerMax: 0xff } }],
    },
  ],
};

const trans: GetBehaviorDetailsResponse = { id: 3, displayName: 'Transparent', metadata: [] };
const none: GetBehaviorDetailsResponse = { id: 4, displayName: 'None', metadata: [] };

describe('formatBinding', () => {
  it('labels a key press by its keycode', () => {
    const f = formatBinding(
      { behaviorId: 1, param1: encodeKeycode(HID_USAGE_KEY, 0x04), param2: 0 },
      kp,
      layerName,
    );
    expect(f.label).toBe('A');
    expect(f.behaviorName).toBe('Key Press');
  });

  it('labels a layer-tap as "layer / key"', () => {
    const f = formatBinding(
      { behaviorId: 2, param1: 2, param2: encodeKeycode(HID_USAGE_KEY, 0x2c) },
      layerTap,
      layerName,
    );
    expect(f.label).toBe('L2 / Space');
  });

  it('marks transparent and none', () => {
    expect(formatBinding({ behaviorId: 3, param1: 0, param2: 0 }, trans, layerName)).toMatchObject({
      transparent: true,
      label: '▽',
    });
    expect(formatBinding({ behaviorId: 4, param1: 0, param2: 0 }, none, layerName)).toMatchObject({
      none: true,
      label: '',
    });
  });

  it('falls back to the behavior name when params are empty', () => {
    const macro: GetBehaviorDetailsResponse = { id: 5, displayName: 'Kill Line', metadata: [] };
    const f = formatBinding({ behaviorId: 5, param1: 0, param2: 0 }, macro, layerName);
    expect(f.label).toBe('Kill Line');
  });
});
