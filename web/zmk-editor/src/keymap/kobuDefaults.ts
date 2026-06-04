/**
 * kobu's stock keymap as written in `firmware/zmk/config/kobu.keymap`,
 * plus its custom behaviors and combos. Used for the offline preview
 * (visualise the default layout without a connected keyboard) and as a
 * reference list in the UI. The live editor reads the real keymap from
 * the device over RPC — this is the compiled default it starts from.
 */

export interface KobuLayer {
  id: number;
  name: string;
  label: string;
  /** 40 devicetree binding strings, position 0..39. */
  bindings: string[];
}

export const KOBU_DEFAULT_LAYERS: KobuLayer[] = [
  {
    id: 0,
    name: 'default_layer',
    label: 'Mac',
    bindings: [
      '&kp Q',
      '&kp W',
      '&kp E',
      '&kp R',
      '&kp T',
      '&kp Y',
      '&kp U',
      '&kp I',
      '&kp O',
      '&kp P',
      '&kp A',
      '&kp S',
      '&kp D',
      '&kp F',
      '&kp G',
      '&kp H',
      '&kp J',
      '&kp K',
      '&kp L',
      '&ht_cmd_shift_colon 0 0',
      '&kp Z',
      '&kp X',
      '&kp C',
      '&kp V',
      '&kp B',
      '&kp N',
      '&kp M',
      '&kp COMMA',
      '&kp DOT',
      '&ht_cmd_ctrl_qmark 0 0',
      '&none',
      '&kmt LGUI BSPC',
      '&kp LCTRL',
      '&kmt LSHFT LANG2',
      '&kp BSPC',
      '&kp BSPC',
      '&kmt LALT ESC',
      '&klt 2 SPACE',
      '&klt 3 ENTER',
      '&none',
    ],
  },
  {
    id: 1,
    name: 'layer1',
    label: 'Win/Linux',
    bindings: [
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&ht_ctrl_shift_colon 0 0',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&ht_ctrl_alt_qmark 0 0',
      '&trans',
      '&trans',
      '&kmt LALT BSPC',
      '&klt 5 LGUI',
      '&trans',
      '&kmt LGUI ESC',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
    ],
  },
  {
    id: 2,
    name: 'layer2',
    label: 'Numbers/Symbols',
    bindings: [
      '&kp N1',
      '&kp N2',
      '&kp N3',
      '&kp N4',
      '&kp N5',
      '&kp N6',
      '&kp N7',
      '&kp N8',
      '&kp N9',
      '&kp N0',
      '&kp EXCL',
      '&kp AT',
      '&kp HASH',
      '&kp DLLR',
      '&kp PRCNT',
      '&kp LEFT',
      '&kp DOWN',
      '&kp UP',
      '&kp RIGHT',
      '&trans',
      '&kp CARET',
      '&kp AMPS',
      '&kp STAR',
      '&kp LPAR',
      '&kp RPAR',
      '&none',
      '&none',
      '&none',
      '&none',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&kmt LSHFT LANG1',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
    ],
  },
  {
    id: 3,
    name: 'layer3',
    label: 'Settings/Media/BLE',
    bindings: [
      '&bt BT_SEL 0',
      '&bt BT_SEL 1',
      '&bt BT_SEL 2',
      '&bt BT_SEL 3',
      '&none',
      '&kp C_PREV',
      '&kp C_PP',
      '&kp C_NEXT',
      '&kp C_VOL_DN',
      '&kp C_VOL_UP',
      '&kp F1',
      '&kp F2',
      '&kp F3',
      '&kp F4',
      '&kp F5',
      '&kp F6',
      '&kp F7',
      '&kp F8',
      '&kp F9',
      '&kp F10',
      '&to 0',
      '&tog 1',
      '&none',
      '&none',
      '&bt BT_CLR',
      '&kp F11',
      '&kp F12',
      '&kp F13',
      '&none',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&kp DEL',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
    ],
  },
  {
    id: 4,
    name: 'layer4',
    label: 'Mouse/Auto-Mouse',
    bindings: [
      '&kp LG(LS(LBKT))',
      '&kp LG(LS(RBKT))',
      '&none',
      '&none',
      '&none',
      '&mkp MB1',
      '&mkp MB2',
      '&mkp MB2',
      '&mkp MB3',
      '&trans',
      '&ht_shift_lgbkt LSHFT LG(LBKT)',
      '&kp LG(RBKT)',
      '&kp TAB',
      '&kp LGUI',
      '&none',
      '&none',
      '&none',
      '&none',
      '&none',
      '&trans',
      '&kp LCTRL',
      '&none',
      '&kp LG(C)',
      '&kp LG(V)',
      '&none',
      '&none',
      '&none',
      '&none',
      '&none',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
    ],
  },
  {
    id: 5,
    name: 'layer5',
    label: 'Emacs',
    bindings: [
      '&kp LC(Q)',
      '&kp LC(W)',
      '&kp END',
      '&kp LC(R)',
      '&kp LC(T)',
      '&kp LC(Y)',
      '&kp LC(U)',
      '&kp LC(I)',
      '&kp LC(O)',
      '&kp UP',
      '&td_home_ctla',
      '&kp LC(S)',
      '&kp DEL',
      '&kp RIGHT',
      '&kp LC(G)',
      '&kp BSPC',
      '&kp LC(J)',
      '&td_kill_line',
      '&kp LC(L)',
      '&kp LC(SEMI)',
      '&kp LC(Z)',
      '&kp LC(X)',
      '&kp LC(C)',
      '&kp LC(V)',
      '&kp LEFT',
      '&kp DOWN',
      '&kp LC(M)',
      '&kp LC(COMMA)',
      '&kp LC(DOT)',
      '&kp LC(APOS)',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
    ],
  },
  {
    id: 6,
    name: 'layer6',
    label: 'Neovim',
    bindings: [
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&kp LCTRL',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
      '&trans',
    ],
  },
];

export type KobuBehaviorType = 'macro' | 'mod-morph' | 'tap-dance' | 'hold-tap';

export interface KobuBehaviorDef {
  id: string;
  label: string;
  type: KobuBehaviorType;
  /** devicetree #binding-cells (params consumed when referenced). */
  params: 0 | 2;
  shape: string;
}

export const KOBU_BEHAVIORS: KobuBehaviorDef[] = [
  {
    id: 'macro_kill_line',
    label: 'Kill Line',
    type: 'macro',
    params: 0,
    shape: 'Shift+End → Del（行末まで削除 / Emacs Ctrl+K）',
  },
  {
    id: 'mod_cmd_shift',
    label: 'Cmd+Shift 長押し',
    type: 'macro',
    params: 0,
    shape: 'Cmd+Shift を押し続ける',
  },
  {
    id: 'mod_cmd_ctrl',
    label: 'Cmd+Ctrl 長押し',
    type: 'macro',
    params: 0,
    shape: 'Cmd+Ctrl を押し続ける',
  },
  {
    id: 'mod_cmd_alt',
    label: 'Cmd+Alt 長押し',
    type: 'macro',
    params: 0,
    shape: 'Cmd+Alt を押し続ける',
  },
  {
    id: 'mod_ctrl_shift',
    label: 'Ctrl+Shift 長押し',
    type: 'macro',
    params: 0,
    shape: 'Ctrl+Shift を押し続ける',
  },
  {
    id: 'mod_ctrl_alt',
    label: 'Ctrl+Alt 長押し',
    type: 'macro',
    params: 0,
    shape: 'Ctrl+Alt を押し続ける',
  },
  { id: 'colon_semi', label: ': / ;', type: 'mod-morph', params: 0, shape: '通常 ":" / Shift ";"' },
  {
    id: 'mm_pipe_bslash',
    label: '| / \\',
    type: 'mod-morph',
    params: 0,
    shape: '通常 "|" / Shift "\\"',
  },
  {
    id: 'mm_minus_under',
    label: '- / _',
    type: 'mod-morph',
    params: 0,
    shape: '通常 "-" / Shift "_"',
  },
  {
    id: 'mm_equal_plus',
    label: '= / +',
    type: 'mod-morph',
    params: 0,
    shape: '通常 "=" / Shift "+"',
  },
  {
    id: 'mm_squote_dquote',
    label: '\' / "',
    type: 'mod-morph',
    params: 0,
    shape: '通常 "\'" / Shift \'"\'',
  },
  {
    id: 'mm_qmark_slash',
    label: '/ / ?',
    type: 'mod-morph',
    params: 0,
    shape: '通常 "/" / Shift "?"',
  },
  {
    id: 'mm_grave_tilde',
    label: '` / ~',
    type: 'mod-morph',
    params: 0,
    shape: '通常 "`" / Shift "~"',
  },
  {
    id: 'mm_lbkt_lbrc',
    label: '[ / {',
    type: 'mod-morph',
    params: 0,
    shape: '通常 "[" / Shift "{"',
  },
  {
    id: 'mm_rbkt_rbrc',
    label: '] / }',
    type: 'mod-morph',
    params: 0,
    shape: '通常 "]" / Shift "}"',
  },
  {
    id: 'td_kill_line',
    label: 'TD: Kill Line',
    type: 'tap-dance',
    params: 0,
    shape: 'タップ Ctrl+K / ダブルタップ 行末削除',
  },
  {
    id: 'td_home_ctla',
    label: 'TD: Home / Ctrl+A',
    type: 'tap-dance',
    params: 0,
    shape: 'タップ Home / ダブルタップ Ctrl+A',
  },
  {
    id: 'kmt',
    label: 'Mod-Tap（汎用）',
    type: 'hold-tap',
    params: 2,
    shape: '長押し=修飾(1) / タップ=キー(2)。例: &kmt LGUI BSPC',
  },
  {
    id: 'klt',
    label: 'Layer-Tap（汎用）',
    type: 'hold-tap',
    params: 2,
    shape: '長押し=レイヤー(1) / タップ=キー(2)。例: &klt 2 SPACE',
  },
  {
    id: 'ht_cmd_shift_colon',
    label: 'Cmd+Shift / :',
    type: 'hold-tap',
    params: 2,
    shape: '長押し Cmd+Shift / タップ : ;',
  },
  {
    id: 'ht_cmd_ctrl_qmark',
    label: 'Cmd+Ctrl / ?',
    type: 'hold-tap',
    params: 2,
    shape: '長押し Cmd+Ctrl / タップ / ?',
  },
  {
    id: 'ht_ctrl_shift_colon',
    label: 'Ctrl+Shift / :',
    type: 'hold-tap',
    params: 2,
    shape: '長押し Ctrl+Shift / タップ : ;',
  },
  {
    id: 'ht_ctrl_alt_qmark',
    label: 'Ctrl+Alt / ?',
    type: 'hold-tap',
    params: 2,
    shape: '長押し Ctrl+Alt / タップ / ?',
  },
  {
    id: 'ht_shift_lgbkt',
    label: 'Shift / Cmd+[',
    type: 'hold-tap',
    params: 2,
    shape: '長押し Shift / タップ Cmd+[',
  },
];

export interface KobuCombo {
  id: string;
  label: string;
  keyPositions: number[];
  binding: string;
  timeoutMs: number;
  /** 'all' = active on every layer; otherwise the layer ids it is gated to. */
  layers: 'all' | number[];
}

export const KOBU_COMBOS: KobuCombo[] = [
  {
    id: 'combo_grave',
    label: '` / ~',
    keyPositions: [0, 1],
    binding: '&mm_grave_tilde',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_tab',
    label: 'Tab',
    keyPositions: [10, 11],
    binding: '&kp TAB',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_yu_bspc',
    label: 'Backspace',
    keyPositions: [5, 6],
    binding: '&kp BSPC',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_pipe',
    label: '| / \\',
    keyPositions: [6, 7],
    binding: '&mm_pipe_bslash',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_minus',
    label: '- / _',
    keyPositions: [7, 8],
    binding: '&mm_minus_under',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_plus',
    label: '= / +',
    keyPositions: [8, 9],
    binding: '&mm_equal_plus',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_lbkt',
    label: '[ / {',
    keyPositions: [16, 17],
    binding: '&mm_lbkt_lbrc',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_rbkt',
    label: '] / }',
    keyPositions: [17, 18],
    binding: '&mm_rbkt_rbrc',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_squote',
    label: '\' / "',
    keyPositions: [18, 19],
    binding: '&mm_squote_dquote',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_bspc',
    label: 'Backspace',
    keyPositions: [25, 26],
    binding: '&kp BSPC',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_question',
    label: '/ / ?',
    keyPositions: [27, 28],
    binding: '&mm_qmark_slash',
    timeoutMs: 50,
    layers: 'all',
  },
  {
    id: 'combo_cmd_alt',
    label: 'Cmd+Alt',
    keyPositions: [12, 13],
    binding: '&mod_cmd_alt',
    timeoutMs: 50,
    layers: [0],
  },
  {
    id: 'combo_ctrl_alt',
    label: 'Ctrl+Alt',
    keyPositions: [12, 13],
    binding: '&mod_ctrl_alt',
    timeoutMs: 50,
    layers: [1],
  },
  {
    id: 'combo_neovim_toggle',
    label: 'Neovim 切替',
    keyPositions: [11, 12],
    binding: '&tog 6',
    timeoutMs: 50,
    layers: [1, 6],
  },
];

const BEHAVIOR_LABELS = new Map(KOBU_BEHAVIORS.map((b) => [b.id, b.label] as const));

/**
 * Pretty-print a devicetree binding string for the offline preview, e.g.
 * `&kp Q` → `Q`, `&klt 2 SPACE` → `L2/SPACE`, `&trans` → `▽`. This is a
 * best-effort textual formatter for the default keymap only; the live
 * editor renders bindings from device metadata (see `binding.ts`).
 */
export function formatDtBinding(binding: string): string {
  const s = binding.trim();
  if (s === '&none') return '';
  if (s === '&trans') return '▽';
  const m = /^&(\S+)\s*(.*)$/.exec(s);
  if (!m) return s;
  const ref = m[1] ?? '';
  const rest = (m[2] ?? '').trim();
  switch (ref) {
    case 'kp':
      return rest;
    case 'mo':
      return `MO${rest}`;
    case 'to':
      return `TO${rest}`;
    case 'tog':
      return `TOG${rest}`;
    case 'mkp':
      return rest;
    case 'bt':
      return rest.replace('BT_SEL ', 'BT').replace('BT_CLR', 'BT✕');
    case 'kmt': {
      const [mod, ...key] = rest.split(/\s+/);
      return `${mod}/${key.join(' ')}`;
    }
    case 'klt': {
      const [layer, ...key] = rest.split(/\s+/);
      return `L${layer}/${key.join(' ')}`;
    }
    default: {
      const label = BEHAVIOR_LABELS.get(ref);
      if (label) return label;
      return rest ? `${ref} ${rest}` : ref;
    }
  }
}
