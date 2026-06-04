/** The three ZMK UF2 images published to the `firmware-latest` release. */
export interface InstallTarget {
  id: 'left' | 'right' | 'reset';
  asset: string;
  label: string;
  description: string;
}

export const ZMK_TARGETS: InstallTarget[] = [
  {
    id: 'left',
    asset: 'kobu_left.uf2',
    label: '左（セントラル）',
    description: 'ZMK Studio 対応。キーマップ編集はこの左半分に接続します。',
  },
  {
    id: 'right',
    asset: 'kobu_right.uf2',
    label: '右（ペリフェラル）',
    description: '右半分。トラックボール（ポインタ）側。',
  },
  {
    id: 'reset',
    asset: 'kobu_reset.uf2',
    label: '設定リセット',
    description:
      'BLE ボンドや保存設定を消去する settings_reset イメージ。書き込み後に通常ファームを再度書き込んでください。',
  },
];
