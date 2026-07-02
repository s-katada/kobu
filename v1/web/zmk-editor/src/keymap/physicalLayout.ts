/**
 * kobu's 40-key (4×10) physical layout, in ZMK 1/100-key units, mirroring
 * `v1/firmware/zmk/config/boards/shields/kobu/kobu.dtsi`.
 *
 * The live editor prefers the layout the firmware reports over the Studio
 * RPC (`getPhysicalLayouts`); this hardcoded copy is the fallback for the
 * offline default-keymap preview and for rendering before/without a
 * connection. Positions 30 and 39 are phantom (the thumb cluster's
 * `&none` slots — no physical switch).
 */

export interface PhysicalKey {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Phantom slot (`&none`, no switch). kobu: positions 30 & 39. */
  phantom?: boolean;
}

export const KOBU_PHYSICAL_LAYOUT: PhysicalKey[] = [
  { x: 0, y: 0, width: 100, height: 100 },
  { x: 100, y: 0, width: 100, height: 100 },
  { x: 200, y: 0, width: 100, height: 100 },
  { x: 300, y: 0, width: 100, height: 100 },
  { x: 400, y: 0, width: 100, height: 100 },
  { x: 650, y: 0, width: 100, height: 100 },
  { x: 750, y: 0, width: 100, height: 100 },
  { x: 850, y: 0, width: 100, height: 100 },
  { x: 950, y: 0, width: 100, height: 100 },
  { x: 1050, y: 0, width: 100, height: 100 },
  { x: 0, y: 100, width: 100, height: 100 },
  { x: 100, y: 100, width: 100, height: 100 },
  { x: 200, y: 100, width: 100, height: 100 },
  { x: 300, y: 100, width: 100, height: 100 },
  { x: 400, y: 100, width: 100, height: 100 },
  { x: 650, y: 100, width: 100, height: 100 },
  { x: 750, y: 100, width: 100, height: 100 },
  { x: 850, y: 100, width: 100, height: 100 },
  { x: 950, y: 100, width: 100, height: 100 },
  { x: 1050, y: 100, width: 100, height: 100 },
  { x: 0, y: 200, width: 100, height: 100 },
  { x: 100, y: 200, width: 100, height: 100 },
  { x: 200, y: 200, width: 100, height: 100 },
  { x: 300, y: 200, width: 100, height: 100 },
  { x: 400, y: 200, width: 100, height: 100 },
  { x: 650, y: 200, width: 100, height: 100 },
  { x: 750, y: 200, width: 100, height: 100 },
  { x: 850, y: 200, width: 100, height: 100 },
  { x: 950, y: 200, width: 100, height: 100 },
  { x: 1050, y: 200, width: 100, height: 100 },
  { x: 0, y: 300, width: 100, height: 100, phantom: true },
  { x: 100, y: 300, width: 100, height: 100 },
  { x: 250, y: 300, width: 100, height: 100 },
  { x: 350, y: 300, width: 100, height: 100 },
  { x: 450, y: 300, width: 100, height: 100 },
  { x: 600, y: 300, width: 100, height: 100 },
  { x: 700, y: 300, width: 100, height: 100 },
  { x: 800, y: 300, width: 100, height: 100 },
  { x: 950, y: 300, width: 100, height: 100 },
  { x: 1050, y: 300, width: 100, height: 100, phantom: true },
];

export interface LayoutBounds {
  width: number;
  height: number;
}

/** Rightmost / bottommost extent of a set of keys, in the same units. */
export function layoutBounds(
  keys: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): LayoutBounds {
  let width = 0;
  let height = 0;
  for (const k of keys) {
    width = Math.max(width, k.x + k.width);
    height = Math.max(height, k.y + k.height);
  }
  return { width, height };
}
