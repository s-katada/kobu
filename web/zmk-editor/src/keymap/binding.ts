/**
 * Turn a live `BehaviorBinding` (from the device) into a key-cap label,
 * using the behavior metadata the firmware reports via
 * `getBehaviorDetails`.
 *
 * Each behavior advertises up to two parameter "sets", and each set
 * describes `param1` / `param2` as a list of value descriptions — a named
 * constant, a numeric range, a HID usage, or a layer id. We label a
 * binding by interpreting its raw `param1` / `param2` against those
 * descriptions (mirroring how ZMK Studio's official client does it).
 */

import type {
  BehaviorBinding,
  BehaviorParameterValueDescription,
  GetBehaviorDetailsResponse,
} from '../rpc/types';
import { keycodeLabel } from './hidUsages';

export interface FormattedBinding {
  /** Behavior display name, e.g. "Key Press", "Layer Tap". */
  behaviorName: string;
  /** Compact key-cap label, e.g. "A", "L2 / Space", "Cmd+Shift / :". */
  label: string;
  /** True for the transparent (`&trans`) behavior. */
  transparent: boolean;
  /** True for the empty (`&none`) behavior. */
  none: boolean;
}

const EMPTY: FormattedBinding = {
  behaviorName: '',
  label: '',
  transparent: false,
  none: true,
};

function looksTransparent(name: string): boolean {
  return /trans/i.test(name);
}

function looksNone(name: string): boolean {
  return /^none$/i.test(name) || name === '';
}

function formatParam(
  descs: BehaviorParameterValueDescription[] | undefined,
  value: number,
  layerName: (id: number) => string,
): string {
  if (!descs || descs.length === 0) return '';
  // A named constant wins if it matches the raw value exactly.
  for (const d of descs) {
    if (d.constant !== undefined && d.constant === value) return d.name || String(value);
  }
  for (const d of descs) {
    if (d.layerId !== undefined) return layerName(value);
    if (d.hidUsage !== undefined) return keycodeLabel(value);
    if (d.range !== undefined) return String(value);
  }
  return '';
}

export function formatBinding(
  binding: BehaviorBinding | undefined,
  behavior: GetBehaviorDetailsResponse | undefined,
  layerName: (id: number) => string,
): FormattedBinding {
  if (!binding) return EMPTY;
  const behaviorName = behavior?.displayName ?? `#${binding.behaviorId}`;
  if (looksTransparent(behaviorName)) {
    return { behaviorName, label: '▽', transparent: true, none: false };
  }
  if (looksNone(behaviorName)) {
    return { behaviorName, label: '', transparent: false, none: true };
  }
  const set = behavior?.metadata?.[0];
  const p1 = formatParam(set?.param1, binding.param1, layerName);
  const p2 = formatParam(set?.param2, binding.param2, layerName);
  const parts = [p1, p2].filter((s) => s.length > 0);
  const label = parts.length > 0 ? parts.join(' / ') : behaviorName;
  return { behaviorName, label, transparent: false, none: false };
}
