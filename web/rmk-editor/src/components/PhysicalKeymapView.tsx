/**
 * 実機イラストビュー。
 *
 * `layout/kobuPhysical.ts` の CAD 由来ジオメトリ（mm）を使って、kobu の
 * 実機そのままの姿 — カラムスタッガーの 5x3 メインブロック、扇状の
 * 親指キー 4 個、XIAO カバー、トラックボール — を描く。
 *
 * 構造は 3 層:
 *   1. SVG 下地（プレートシルエット・ベゼル・XIAO カバー、装飾のみ）
 *   2. 絶対配置の HTML `<button>` キーキャップ（親指キーは CSS rotate）
 *   3. トラックボールの丸ボタン
 *
 * キーのクリックは `onCellClick(row, col)` でグリッドビューと同一の
 * 契約。トラックボールは `onBallClick(side)` — Editor 側で設定ドック
 * (`TrackballDock`) の表示に使う。aria-label もグリッドビューと同じ
 * 「行 r 列 c: …」形式なので、既存の操作系・テストがそのまま通る。
 */

import { useMemo } from 'react';
import { type BallSide, kobuPhysicalLayout, type PhysicalKey } from '../layout/kobuPhysical';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { type KeyLabel, labelForKeycode } from '../protocol/keycodes';
import { accentText, cellTone, centerSize } from './keycapStyle';

/** px / mm。キーキャップが約 47px になり、グリッドビューの密度感と揃う。 */
const SCALE = 3.1;

/** ボールの表示名と役割。`TrackballDock` と共有。 */
export const BALL_LABELS: Record<BallSide, { name: string; role: string }> = {
  left: { name: '左トラックボール', role: 'スクロール' },
  right: { name: '右トラックボール', role: 'ポインタ' },
};

export interface PhysicalKeymapViewProps {
  definition: KeyboardLayoutDef;
  /** アクティブレイヤーのスライス: `keymap[row][col]` (u16)。 */
  keymap: number[][];
  selected: { row: number; col: number } | null;
  isDirty: (row: number, col: number) => boolean;
  onCellClick: (row: number, col: number) => void;
  onCellHover?: (cell: { row: number; col: number } | null) => void;
  /** Vial アンロックコード等、物理的に押すキーのハイライト。 */
  chordCells?: ReadonlyArray<{ row: number; col: number }>;
  chordActive?: boolean;
  /** 選択中のトラックボール（設定ドックが開いている側）。 */
  selectedBall?: BallSide | null;
  onBallClick?: (side: BallSide) => void;
}

export function PhysicalKeymapView({
  definition,
  keymap,
  selected,
  isDirty,
  onCellClick,
  onCellHover,
  chordCells,
  chordActive = false,
  selectedBall = null,
  onBallClick,
}: PhysicalKeymapViewProps) {
  const layout = useMemo(() => kobuPhysicalLayout(), []);
  const width = layout.widthMm * SCALE;
  const height = layout.heightMm * SCALE;

  return (
    <div className="w-full overflow-x-auto">
      <div className="w-fit mx-auto">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 実機配置のキーキャップ群; 操作は子の <button> が受け、ラッパは hover 解除だけを拾う */}
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label はイラスト全体の領域ラベルとして機能する */}
        <div
          aria-label="kobu キーボード（実機ビュー）"
          className="relative select-none mx-auto"
          style={{ width: `${width}px`, height: `${height}px` }}
          onMouseLeave={() => onCellHover?.(null)}
        >
        <Underlay layout={layout} />
        {layout.keys.map((key) => {
          const value = keymap[key.row]?.[key.col] ?? 0;
          const label = labelForKeycode(value, { definition });
          const isSelected =
            selected !== null && selected.row === key.row && selected.col === key.col;
          const isChord =
            chordActive === true &&
            chordCells?.some((c) => c.row === key.row && c.col === key.col) === true;
          return (
            <PhysicalKeycap
              key={`${key.row}-${key.col}`}
              physicalKey={key}
              keyWidth={layout.keyWidthMm * SCALE}
              keyHeight={layout.keyHeightMm * SCALE}
              label={label}
              selected={isSelected}
              dirty={isDirty(key.row, key.col)}
              chord={isChord}
              onClick={() => onCellClick(key.row, key.col)}
              onMouseEnter={() => onCellHover?.({ row: key.row, col: key.col })}
            />
          );
        })}
          {layout.balls.map((ball) => (
            <TrackballButton
              key={ball.side}
              side={ball.side}
              x={ball.x * SCALE}
              y={ball.y * SCALE}
              radius={ball.ballRadius * SCALE}
              selected={selectedBall === ball.side}
              onClick={() => onBallClick?.(ball.side)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── SVG 下地（装飾） ────────────────────────────────────────────────────

interface UnderlayProps {
  layout: ReturnType<typeof kobuPhysicalLayout>;
}

function Underlay({ layout }: UnderlayProps) {
  // 実機のハウジングはベアリング窓が Y 字配置（下 1 つ + 上 2 つ）。
  const notchAngles = [90, 235, 305];
  const bandPath = (p: (typeof layout.thumbPlates)[number]) =>
    p.points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`).join(' ');
  const sides = ['left', 'right'] as const;
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none overflow-visible"
      width={layout.widthMm * SCALE}
      height={layout.heightMm * SCALE}
      viewBox={`0 0 ${layout.widthMm} ${layout.heightMm}`}
    >
      {/* 半身ごとに 1 グループ = ケース全体のシルエットに落ち影 (.kobu-case) */}
      {sides.map((side) => {
        const band = layout.thumbPlates.find((p) => p.side === side);
        const bump = layout.hingeBumps.find((h) => h.side === side);
        const column = layout.thumbColumns.find((c) => c.side === side);
        const filler = layout.thumbFillers.find((f) => f.side === side);
        const xiao = layout.xiaos.find((x) => x.side === side);
        const ball = layout.balls.find((b) => b.side === side);
        const xiaoTop = xiao ? xiao.y - xiao.height / 2 : 0;
        return (
          <g key={side} className="kobu-case">
            {/* メインユニットのプレート（列ストリップの重なりで段差輪郭を作る） */}
            {layout.mainPlates
              .filter((r) => r.side === side)
              .map((r) => (
                <rect
                  key={`plate-${side}-${r.x.toFixed(1)}`}
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  rx={r.radius}
                  className="fill-white dark:fill-zinc-800"
                />
              ))}
            {/* 親指ユニット。影色の細縁 (.kobu-seam) を先に敷いてから本体を重ね、
                メインプレートと重なる部分に実機の継ぎ目の影線を出す。
                ヒンジタブ → 帯 の順で本体を描き、タブと帯の境目には線を出さない。 */}
            {band && (
              <>
                {bump && (
                  <circle cx={bump.x} cy={bump.y} r={bump.radius + 0.6} className="kobu-seam-fill" />
                )}
                <path
                  d={bandPath(band)}
                  fill="none"
                  strokeWidth={band.width + 1.2}
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                  className="kobu-seam"
                />
                {bump && (
                  <circle
                    cx={bump.x}
                    cy={bump.y}
                    r={bump.radius}
                    className="fill-white dark:fill-zinc-800"
                  />
                )}
                <path
                  d={bandPath(band)}
                  fill="none"
                  strokeWidth={band.width}
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                  className="stroke-white dark:stroke-zinc-800"
                />
              </>
            )}
            {/* 斜めカット上角とハウジング円を繋ぐ面取り */}
            {filler && filler.points.length >= 3 && (
              <polygon
                points={filler.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
                className="fill-white dark:fill-zinc-800"
              />
            )}
            {/* 柱プレート: XIAO とハウジングの土台。縁は縦横の直線 */}
            {column && (
              <rect
                x={column.x}
                y={column.y}
                width={column.width}
                height={column.height}
                rx={column.radius}
                className="fill-white dark:fill-zinc-800"
              />
            )}
            {/* XIAO カバープレート。下端はボールハウジングの裏に隠れる。
                上部のディテールはリセットボタンのピル穴（左）+ LED 窓（右）—
                XIAO モジュールは鏡像にできないため左右どちらの半身でも同じ向き。 */}
            {xiao && (
              <>
                <rect
                  x={xiao.x - xiao.width / 2}
                  y={xiaoTop}
                  width={xiao.width}
                  height={xiao.height}
                  rx={2.5}
                  strokeWidth={0.4}
                  className="fill-white stroke-zinc-200 dark:fill-zinc-800 dark:stroke-zinc-700"
                />
                <rect
                  x={xiao.x - 4 - 1.7}
                  y={xiaoTop + 2.6}
                  width={3.4}
                  height={4.8}
                  rx={1.7}
                  strokeWidth={0.4}
                  className="fill-zinc-100 stroke-zinc-300 dark:fill-zinc-600 dark:stroke-zinc-500"
                />
                <circle
                  cx={xiao.x + 5.5}
                  cy={xiaoTop + 4.4}
                  r={1.1}
                  className="fill-zinc-500 dark:fill-zinc-950"
                />
              </>
            )}
            {/* トラックボールのハウジング: ベゼル + ボール周りの凹み + ベアリング窓 */}
            {ball && (
              <>
                <circle
                  cx={ball.x}
                  cy={ball.y}
                  r={ball.bezelRadius}
                  strokeWidth={0.5}
                  className="fill-white stroke-zinc-200 dark:fill-zinc-800 dark:stroke-zinc-700"
                />
                <circle
                  cx={ball.x}
                  cy={ball.y}
                  r={ball.ballRadius + 1.5}
                  className="fill-zinc-300 dark:fill-zinc-950"
                />
                {notchAngles.map((deg) => {
                  const rad = (deg * Math.PI) / 180;
                  const r = ball.ballRadius + 2.4;
                  const nx = ball.x + r * Math.cos(rad);
                  const ny = ball.y + r * Math.sin(rad);
                  return (
                    <rect
                      key={deg}
                      x={nx - 2.7}
                      y={ny - 1.3}
                      width={5.4}
                      height={2.6}
                      rx={1.3}
                      strokeWidth={0.3}
                      transform={`rotate(${deg + 90} ${nx} ${ny})`}
                      className="fill-zinc-200 stroke-zinc-400 dark:fill-zinc-500 dark:stroke-zinc-400"
                    />
                  );
                })}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── キーキャップ ────────────────────────────────────────────────────────

interface PhysicalKeycapProps {
  physicalKey: PhysicalKey;
  keyWidth: number;
  keyHeight: number;
  label: KeyLabel;
  selected: boolean;
  dirty: boolean;
  chord: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
}

function PhysicalKeycap({
  physicalKey,
  keyWidth,
  keyHeight,
  label,
  selected,
  dirty,
  chord,
  onClick,
  onMouseEnter,
}: PhysicalKeycapProps) {
  const left = physicalKey.x * SCALE - keyWidth / 2;
  const top = physicalKey.y * SCALE - keyHeight / 2;

  return (
    <button
      type="button"
      aria-label={`行 ${physicalKey.row} 列 ${physicalKey.col}: ${label.long}`}
      aria-pressed={selected}
      title={label.long}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onFocus={onMouseEnter}
      className={[
        // .kobu-cap = キャップ側面のグラデ + デスクへの接地影
        'kobu-cap absolute rounded-md text-zinc-900 dark:text-zinc-50',
        // rotate を inline transform で使うため、hover は持ち上げではなく明るさで表現
        'transition-[box-shadow,filter] duration-100',
        'hover:brightness-[1.04] dark:hover:brightness-110',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        selected ? 'ring-2 ring-sky-500 z-10' : '',
        chord ? 'ring-2 ring-amber-500 motion-safe:animate-pulse z-10' : '',
      ].join(' ')}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${keyWidth}px`,
        height: `${keyHeight}px`,
        transform: `rotate(${physicalKey.rot}deg)`,
      }}
    >
      {/* キャップ上面 — 側面より一回り小さく、下側を広めに残して高さを出す */}
      <span
        className={[
          'absolute left-[7%] right-[7%] top-[4%] bottom-[12%]',
          'rounded-[5px] border flex flex-col items-center justify-center overflow-hidden',
          'pointer-events-none',
          cellTone(label.tone),
        ].join(' ')}
      >
        {/* 上面のグロス（上からの光） */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-[5px] bg-gradient-to-b from-white/55 via-white/0 to-black/[0.05] dark:from-white/10 dark:to-black/25"
        />
        {label.top !== '' && (
          <span
            className={[
              'absolute left-0.5 right-0.5 top-0.5 text-[9px] font-bold tracking-tight leading-none',
              'truncate text-center',
              accentText(label.accent),
            ].join(' ')}
          >
            {label.top}
          </span>
        )}
        <span
          className={[
            'relative font-medium leading-none text-center px-0.5',
            centerSize(label.center),
            label.tone === 'muted' ? 'text-zinc-400 dark:text-zinc-600' : '',
          ].join(' ')}
        >
          {label.center}
        </span>
        {label.bottom !== '' && (
          <span className="absolute bottom-0.5 left-0.5 right-0.5 text-[9px] leading-none text-zinc-500 dark:text-zinc-400 truncate text-center">
            {label.bottom}
          </span>
        )}
      </span>
      {dirty && (
        <span
          title="未保存の変更あり"
          className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-zinc-900 z-10"
        />
      )}
    </button>
  );
}

// ─── トラックボール ──────────────────────────────────────────────────────

interface TrackballButtonProps {
  side: BallSide;
  /** ボール中心 (px)。 */
  x: number;
  y: number;
  radius: number;
  selected: boolean;
  onClick: () => void;
}

function TrackballButton({ side, x, y, radius, selected, onClick }: TrackballButtonProps) {
  const meta = BALL_LABELS[side];
  return (
    <button
      type="button"
      aria-label={`${meta.name}（${meta.role}）の設定`}
      aria-pressed={selected}
      title={`${meta.name} — ${meta.role}。クリックで設定を開く`}
      onClick={onClick}
      className={[
        // .kobu-ball = 球面のラジアルグラデ + 内側陰影 + 凹みへの接地影
        'kobu-ball absolute rounded-full',
        'transition-[box-shadow,filter] duration-100',
        'hover:brightness-105',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        selected ? 'ring-2 ring-sky-500 z-10' : '',
      ].join(' ')}
      style={{
        left: `${x - radius}px`,
        top: `${y - radius}px`,
        width: `${radius * 2}px`,
        height: `${radius * 2}px`,
      }}
    >
      {/* スペキュラハイライト */}
      <span
        aria-hidden
        className="absolute left-[18%] top-[12%] h-[24%] w-[32%] rounded-full bg-white/90 dark:bg-white/45 blur-[2px] pointer-events-none"
      />
    </button>
  );
}
