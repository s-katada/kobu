/**
 * Build-time ("detailed") settings — the kobu firmware knobs that ZMK
 * bakes in at compile time and ZMK Studio cannot change live (trackball
 * CPI, scroll/pointer scaling, hold-tap / tap-dance timing, combo
 * timeout, auto-mouse timeout). Editing any of these requires rebuilding
 * the firmware; the build pipeline (`config/build.ts`) sends the changed
 * values to GitHub Actions, which patches `firmware/zmk/config/*` via
 * `scripts/zmk-apply-overrides.py` and produces fresh UF2s.
 *
 * Each knob's `id` is the override key the patch script understands
 * (except `pointer_gain`, sent as `pointer_gain_x100`).
 */

export type SettingKind = 'int' | 'gain';

export interface SettingDef {
  id: string;
  label: string;
  group: string;
  kind: SettingKind;
  /** Default in display units (gain is a multiplier, e.g. 1.5). */
  default: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  description?: string;
}

export const SETTINGS: SettingDef[] = [
  {
    id: 'left_cpi',
    label: '左トラックボール CPI（スクロール）',
    group: 'トラックボール',
    kind: 'int',
    default: 600,
    min: 100,
    max: 3000,
    step: 50,
    unit: 'CPI',
    description: '左ボール（スクロール）のセンサー解像度。',
  },
  {
    id: 'right_cpi',
    label: '右トラックボール CPI（ポインタ）',
    group: 'トラックボール',
    kind: 'int',
    default: 600,
    min: 100,
    max: 3000,
    step: 50,
    unit: 'CPI',
    description: 'ゲイン適用前のセンサー解像度。',
  },
  {
    id: 'pointer_gain',
    label: 'ポインタ ゲイン',
    group: 'トラックボール',
    kind: 'gain',
    default: 1.5,
    min: 0.5,
    max: 3,
    step: 0.1,
    unit: '×',
    description: '右ボールに掛けるソフトウェア倍率（既定 1.5×）。',
  },
  {
    id: 'scroll_divisor',
    label: 'スクロール感度（分母）',
    group: 'トラックボール',
    kind: 'int',
    default: 18,
    min: 5,
    max: 60,
    step: 1,
    unit: 'counts/line',
    description: '1 行スクロールに必要な生カウント数。小さいほど速くスクロールします。',
  },
  {
    id: 'tapping_term_ms',
    label: 'タップ判定時間（hold-tap / tap-dance）',
    group: 'タイミング',
    kind: 'int',
    default: 200,
    min: 50,
    max: 500,
    step: 10,
    unit: 'ms',
    description: 'これより長く押すと「ホールド」。すべての hold-tap・tap-dance に適用。',
  },
  {
    id: 'combo_timeout_ms',
    label: 'コンボ判定時間',
    group: 'タイミング',
    kind: 'int',
    default: 50,
    min: 10,
    max: 150,
    step: 5,
    unit: 'ms',
    description: '2 キー同時押しをコンボとみなす時間窓。',
  },
  {
    id: 'automouse_timeout_ms',
    label: 'オートマウス解除時間',
    group: 'オートマウス',
    kind: 'int',
    default: 150,
    min: 50,
    max: 600,
    step: 10,
    unit: 'ms',
    description: 'ポインタ停止後にマウスレイヤー（4）が自動解除されるまでの時間。',
  },
];

export const SETTING_DEFAULTS: Record<string, number> = Object.fromEntries(
  SETTINGS.map((s) => [s.id, s.default]),
);

/** The override payload sent to the build, containing only changed knobs. */
export function toOverrides(values: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of SETTINGS) {
    const v = values[s.id];
    if (v === undefined || v === s.default) continue;
    if (s.id === 'pointer_gain') {
      out.pointer_gain_x100 = Math.round(v * 100);
    } else {
      out[s.id] = Math.round(v);
    }
  }
  return out;
}

export function changedCount(values: Record<string, number>): number {
  return SETTINGS.filter((s) => values[s.id] !== undefined && values[s.id] !== s.default).length;
}
