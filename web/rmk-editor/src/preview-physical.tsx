/**
 * 開発専用プレビュー: PhysicalKeymapView を接続なしで表示する。
 * keyboard.toml のレイヤー 0 を Via コードで再現したダミーデータ。
 * `pnpm dev` → http://localhost:5173/preview-physical.html
 */

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PhysicalKeymapView } from './components/PhysicalKeymapView';
import type { BallSide } from './layout/kobuPhysical';
import type { KeyboardLayoutDef } from './protocol/handshake';
import './index.css';

const DEFINITION: KeyboardLayoutDef = {
  matrix: { rows: 4, cols: 10 },
  customKeycodes: [],
  layouts: { keymap: [] },
};

// keyboard.toml レイヤー 0 (Mac/default)
const LAYER0: number[][] = [
  [0x14, 0x1a, 0x08, 0x15, 0x17, 0x1c, 0x18, 0x0c, 0x12, 0x13],
  [0x04, 0x16, 0x07, 0x09, 0x0a, 0x0b, 0x0d, 0x0e, 0x0f, 0x2a33],
  [0x1d, 0x1b, 0x06, 0x19, 0x05, 0x11, 0x10, 0x36, 0x37, 0x2938],
  [0x0000, 0x282a, 0x00e0, 0x2291, 0x002a, 0x002a, 0x2429, 0x422c, 0x4328, 0x0000],
];

function Preview() {
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [ball, setBall] = useState<BallSide | null>(null);
  return (
    <div className="min-h-full bg-zinc-50 dark:bg-zinc-950 p-8">
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-950 shadow-sm p-4 max-w-6xl mx-auto">
        <PhysicalKeymapView
          definition={DEFINITION}
          keymap={LAYER0}
          selected={selected}
          isDirty={(row, col) => row === 1 && col === 9}
          onCellClick={(row, col) => {
            setBall(null);
            setSelected({ row, col });
          }}
          selectedBall={ball}
          onBallClick={(side) => {
            setSelected(null);
            setBall(side);
          }}
        />
      </div>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Preview />
    </StrictMode>,
  );
}
