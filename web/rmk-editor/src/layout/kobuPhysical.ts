/**
 * kobu の物理レイアウト（実機イラストビュー用ジオメトリ）。
 *
 * すべて mm 単位・正面視（y は下向き）で、座標は基板 CAD
 * (`pcb/main-unit-left/*.kicad_pcb` / `pcb/thumb-unit-left/*.kicad_pcb`)
 * のフットプリント座標をそのまま転記している:
 *
 *   * メイン 15 キー  — 16mm ピッチ、カラムスタッガー
 *                       (列ごとの先頭キー y = 99.5 / 91.5 / 87.5 / 89.5 / 91.5)
 *   * 親指 4 キー     — 10° 刻みの扇状配置 (KiCad rot 179.9/169.9/160/150
 *                       → 画面回転 0/10/20/30° 時計回り)
 *   * トラックボール  — PMW3610 (U2) 中心
 *   * XIAO nRF52840   — U1 中心（カバープレートとして描画）
 *
 * 親指ユニットは別基板なので、メイン基板座標系への配置オフセット
 * (`THUMB_UNIT_OFFSET`) だけは実機写真から推定した値。キー同士の相対
 * 位置は CAD 値そのまま。
 *
 * 行列マッピング（keyboard.toml の正準 4x10 レイアウト）:
 *   * 左半身: col 0(外側ピンキー Q/A/Z) .. col 4(内側 T/G/B)
 *   * 右半身: 左のミラー。col = 9 - leftCol (col 5 = 内側 Y/H/N)
 *   * 親指行 row 3: 左 (3,4)=XIAO直下(最内) .. (3,1)=外側、右はミラー。
 *     (3,0) / (3,9) はファントム（スイッチ非実装）なので存在しない。
 */

export type BallSide = 'left' | 'right';

export interface PhysicalKey {
  row: number;
  col: number;
  /** キー中心 (mm, 統合ビュー座標)。 */
  x: number;
  y: number;
  /** 画面上の回転（度、時計回り、中心まわり）。 */
  rot: number;
  side: BallSide;
  /** 親指ユニット上のキーか。 */
  thumb: boolean;
}

export interface PhysicalBall {
  side: BallSide;
  /** ボール中心 (mm)。 */
  x: number;
  y: number;
  /** ハウジング（ベゼル）半径 (mm)。 */
  bezelRadius: number;
  /** ボール半径 (mm)。 */
  ballRadius: number;
}

export interface PhysicalXiao {
  side: BallSide;
  /** カバープレート中心 (mm)。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ヒンジのタブ（メインユニットと親指ユニットを繋ぐ蝶番の出っ張り）。
 * 実機写真では X/C キー下の継ぎ目に小さな半円として見える。
 */
export interface HingeBump {
  side: BallSide;
  x: number;
  y: number;
  radius: number;
}

export interface PlateRect {
  side: BallSide;
  /** 左上 (mm)。 */
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

export interface ThumbPlate {
  side: BallSide;
  /** 帯の中心線を構成する点列 (mm)。round join/cap の太線で描く。 */
  points: Array<{ x: number; y: number }>;
  /** 帯幅 (mm)。 */
  width: number;
}

export interface PhysicalLayout {
  /** 統合ビューの外形 (mm)。 */
  widthMm: number;
  heightMm: number;
  /** 1u キーキャップの描画サイズ (mm)。 */
  keyWidthMm: number;
  keyHeightMm: number;
  keys: PhysicalKey[];
  balls: PhysicalBall[];
  xiaos: PhysicalXiao[];
  mainPlates: PlateRect[];
  thumbPlates: ThumbPlate[];
  /** 親指ユニット内側の縦の柱プレート（XIAO + ハウジングの土台、軸平行）。 */
  thumbColumns: PlateRect[];
  /** 帯の斜めカット上角とハウジング円を繋ぐ面取りポリゴン。 */
  thumbFillers: Array<{ side: BallSide; points: Array<{ x: number; y: number }> }>;
  hingeBumps: HingeBump[];
}

// ─── CAD 由来の定数（左半身、基板座標系 mm） ──────────────────────────────

/** メイン基板: 列の x 中心 (col 0..4)。 */
const MAIN_COL_X = [134, 150, 166, 182, 198] as const;
/** メイン基板: 列ごとの row 0 キー y 中心（カラムスタッガー）。 */
const MAIN_COL_TOP_Y = [99.5, 91.5, 87.5, 89.5, 91.5] as const;
/** 行ピッチ。 */
const ROW_PITCH = 16;

/**
 * 親指ユニット基板（thumb-unit-left.kicad_pcb）のフットプリント中心。
 * rot は KiCad 値 (179.9/169.9/160/150) を画面回転（時計回り）に直した値。
 * col は統合 4x10 レイアウトでの列番号（左半身）。
 */
const THUMB_KEYS = [
  { col: 1, x: 116.512554, y: 113.691744, rot: 0 },
  { col: 2, x: 135.648218, y: 115.487791, rot: 10.1 },
  { col: 3, x: 154.155072, y: 120.735198, rot: 20 },
  { col: 4, x: 171.474834, y: 129.105672, rot: 30 },
] as const;

/** PMW3610 (U2) 中心。 */
const TRACKBALL_CENTER = { x: 175.77, y: 103.15 } as const;
/** XIAO (U1) モジュール中心（フットプリント原点 + モジュール長 21mm の半分）。 */
const XIAO_CENTER = { x: 173.9181, y: 74.11 } as const;

/**
 * 親指ユニット基板 → メイン基板座標系への平行移動。
 * 2 枚の基板は別ファイル（別原点）なので、組み立て後の実機写真
 * （blog step-3-1.jpg）から推定。XIAO がメイン基板右端 (x=207.5) を
 * ちょうど避けて内側カラムの横に並ぶ配置。
 * y はユーザー要望で実機より +6mm 下げ、メインユニットと親指ユニットの
 * 間にはっきり隙間を出している（ヒンジタブがその隙間を橋渡しする）。
 */
const THUMB_UNIT_OFFSET = { x: 48, y: 33 } as const;

// ─── 描画パラメータ ──────────────────────────────────────────────────────

/** 1u キーキャップ描画サイズ。choc キャップ比率で 16mm ピッチに 0.8/1.4mm の目地。 */
const KEY_W = 15.2;
const KEY_H = 14.6;

const BEZEL_R = 16.5;
const BALL_R = 11.5;
/**
 * XIAO カバープレート: 実機ではボールハウジングの裏まで届く縦長プレートで、
 * 上端は XIAO モジュールの少し上、下端はハウジングが覆い隠す位置まで伸びる。
 */
const XIAO_W = 23;
const XIAO_TOP_PAD = 12.5;
const XIAO_BOTTOM_REACH = 5;

/** ヒンジタブ: 外側親指キー (3,1) 中心からのオフセットと半径（実機写真から採寸）。 */
const HINGE_OFFSET = { x: 2.7, y: -12.4 } as const;
const HINGE_R = 3.4;

/** 親指ユニット内側の柱プレート幅。XIAO カバー (23mm) より一回り広い土台。 */
const THUMB_COLUMN_W = 26;

/** メインプレート: キャップ外周からの余白。 */
const PLATE_PAD = 3.2;
/** 親指プレート帯幅。 */
const THUMB_PLATE_W = 25;

/** 外周マージンと左右半身の間隔。 */
const MARGIN = 5;
const HALF_GAP = 12;

/**
 * メインプレート底辺と親指プレート上辺の間の隙間。プレート底辺は帯の
 * 上辺にこの距離で追従し、隙間が平行な帯状に見える（ヒンジ側のキャップ
 * 被覆制約が勝つ列では実機どおりほぼ接触する）。
 */
const MAIN_THUMB_GAP = 2;

// ─── レイアウト構築 ──────────────────────────────────────────────────────

interface LeftGeometry {
  keys: Array<{ row: number; col: number; x: number; y: number; rot: number; thumb: boolean }>;
  ball: { x: number; y: number };
  xiao: { x: number; y: number };
  thumbLine: Array<{ x: number; y: number }>;
  /** 帯の斜めカットとハウジング円を繋ぐ面取りポリゴン。 */
  filler: Array<{ x: number; y: number }>;
  hinge: { x: number; y: number };
}

function buildLeftGeometry(): LeftGeometry {
  const keys: LeftGeometry['keys'] = [];
  for (let col = 0; col < MAIN_COL_X.length; col++) {
    for (let row = 0; row < 3; row++) {
      keys.push({
        row,
        col,
        x: MAIN_COL_X[col] ?? 0,
        y: (MAIN_COL_TOP_Y[col] ?? 0) + row * ROW_PITCH,
        rot: 0,
        thumb: false,
      });
    }
  }
  const t = THUMB_UNIT_OFFSET;
  for (const k of THUMB_KEYS) {
    keys.push({ row: 3, col: k.col, x: k.x + t.x, y: k.y + t.y, rot: k.rot, thumb: true });
  }
  const ball = { x: TRACKBALL_CENTER.x + t.x, y: TRACKBALL_CENTER.y + t.y };
  const xiao = { x: XIAO_CENTER.x + t.x, y: XIAO_CENTER.y + t.y };

  // 親指プレートの中心線: 両端をアーク方向に延長して butt cap の直線カット
  // で終える（外端 = ほぼ垂直のカット、内端 = キーの回転に沿った斜めカットが
  // ハウジングの下から現れる）。延長量 11mm はキー外周 + 余白を覆う長さ。
  const sw5 = keys.find((k) => k.row === 3 && k.col === 1);
  const sw4 = keys.find((k) => k.row === 3 && k.col === 2);
  const sw3 = keys.find((k) => k.row === 3 && k.col === 3);
  const sw2 = keys.find((k) => k.row === 3 && k.col === 4);
  const extendFrom = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const ext = 11 / len;
    return { x: to.x + (to.x - from.x) * ext, y: to.y + (to.y - from.y) * ext };
  };
  const thumbLine: Array<{ x: number; y: number }> = [];
  if (sw5 && sw4) thumbLine.push(extendFrom(sw4, sw5));
  for (const k of keys.filter((k) => k.thumb).sort((a, b) => a.col - b.col)) {
    thumbLine.push({ x: k.x, y: k.y });
  }
  if (sw3 && sw2) thumbLine.push(extendFrom(sw3, sw2));

  // ハウジング円の右の膨らみと斜めカットの間に出来る「湾」を埋めるポリゴン:
  // ボール中心 → ベゼル右端 → カット上角 → カット中点。輪郭はハウジング右端
  // から斜めカットへ一続きの直線エッジになる。
  const filler: Array<{ x: number; y: number }> = [];
  if (sw3 && sw2) {
    const innerEnd = thumbLine[thumbLine.length - 1];
    if (innerEnd) {
      const len = Math.hypot(sw2.x - sw3.x, sw2.y - sw3.y);
      const d = { x: (sw2.x - sw3.x) / len, y: (sw2.y - sw3.y) / len };
      const halfW = THUMB_PLATE_W / 2;
      filler.push(
        { x: ball.x, y: ball.y },
        { x: ball.x + BEZEL_R - 0.3, y: ball.y },
        { x: innerEnd.x + d.y * halfW, y: innerEnd.y - d.x * halfW },
        { x: innerEnd.x, y: innerEnd.y },
      );
    }
  }

  const hinge = sw5
    ? { x: sw5.x + HINGE_OFFSET.x, y: sw5.y + HINGE_OFFSET.y }
    : { x: 0, y: 0 };

  return { keys, ball, xiao, thumbLine, filler, hinge };
}

/** kobu の統合物理レイアウトを構築する。結果は毎回同じ純粋データ。 */
export function kobuPhysicalLayout(): PhysicalLayout {
  const left = buildLeftGeometry();

  // 左半身の外接矩形（プレート余白・回転キー・ベゼルを含む）。
  const keyHalfDiag = (rot: number) => {
    const rad = (Math.abs(rot) * Math.PI) / 180;
    return {
      x: (KEY_W / 2) * Math.cos(rad) + (KEY_H / 2) * Math.sin(rad),
      y: (KEY_W / 2) * Math.sin(rad) + (KEY_H / 2) * Math.cos(rad),
    };
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number, rx: number, ry: number) => {
    minX = Math.min(minX, x - rx);
    maxX = Math.max(maxX, x + rx);
    minY = Math.min(minY, y - ry);
    maxY = Math.max(maxY, y + ry);
  };
  for (const k of left.keys) {
    const half = keyHalfDiag(k.rot);
    const pad = k.thumb ? THUMB_PLATE_W / 2 : KEY_W / 2 + PLATE_PAD;
    include(
      k.x,
      k.y,
      Math.max(half.x, pad),
      Math.max(half.y, k.thumb ? THUMB_PLATE_W / 2 : KEY_H / 2 + PLATE_PAD),
    );
  }
  include(left.ball.x, left.ball.y, BEZEL_R, BEZEL_R);
  // XIAO カバー: 上端 = モジュール上 +余白、下端 = ボール中心の少し下
  // （ハウジングに隠れる）。x はハウジング中心に揃える — CAD では U1 と
  // U2 の x が 1.85mm ずれているが、そのまま描くと柱がねじれて見える。
  const xiaoTop = left.xiao.y - XIAO_TOP_PAD;
  const xiaoBottom = left.ball.y + XIAO_BOTTOM_REACH;
  const xiaoMidY = (xiaoTop + xiaoBottom) / 2;
  const xiaoH = xiaoBottom - xiaoTop;
  include(left.ball.x, xiaoMidY, XIAO_W / 2, xiaoH / 2);
  // 柱プレート: XIAO カバー上端からハウジング裏まで。下端はベゼル円に
  // 完全に隠れる位置で止め、ハウジング下の輪郭は帯の斜めカットに譲る。
  const columnTop = xiaoTop;
  const columnBottom = left.ball.y + 6;
  const columnMidY = (columnTop + columnBottom) / 2;
  const columnH = columnBottom - columnTop;
  include(left.ball.x, columnMidY, THUMB_COLUMN_W / 2, columnH / 2);
  // 帯の両端（延長された butt カット）も外接矩形に含める。
  const firstLinePt = left.thumbLine[0];
  const lastLinePt = left.thumbLine[left.thumbLine.length - 1];
  for (const p of [firstLinePt, lastLinePt]) {
    if (p) include(p.x, p.y, THUMB_PLATE_W / 2 + 0.7, THUMB_PLATE_W / 2 + 0.7);
  }

  const halfWidth = maxX - minX;
  const widthMm = MARGIN * 2 + HALF_GAP + halfWidth * 2;
  const heightMm = MARGIN * 2 + (maxY - minY);

  const toLeft = (p: { x: number; y: number }) => ({
    x: p.x - minX + MARGIN,
    y: p.y - minY + MARGIN,
  });
  const mirrorX = (x: number) => widthMm - x;

  const keys: PhysicalKey[] = [];
  for (const k of left.keys) {
    const p = toLeft(k);
    keys.push({ row: k.row, col: k.col, x: p.x, y: p.y, rot: k.rot, side: 'left', thumb: k.thumb });
    keys.push({
      row: k.row,
      col: 9 - k.col,
      x: mirrorX(p.x),
      y: p.y,
      rot: -k.rot,
      side: 'right',
      thumb: k.thumb,
    });
  }

  const lb = toLeft(left.ball);
  const balls: PhysicalBall[] = [
    { side: 'left', x: lb.x, y: lb.y, bezelRadius: BEZEL_R, ballRadius: BALL_R },
    { side: 'right', x: mirrorX(lb.x), y: lb.y, bezelRadius: BEZEL_R, ballRadius: BALL_R },
  ];

  const lx = toLeft({ x: left.ball.x, y: xiaoMidY });
  const xiaos: PhysicalXiao[] = [
    { side: 'left', x: lx.x, y: lx.y, width: XIAO_W, height: xiaoH },
    { side: 'right', x: mirrorX(lx.x), y: lx.y, width: XIAO_W, height: xiaoH },
  ];

  const lcol = toLeft({ x: left.ball.x - THUMB_COLUMN_W / 2, y: columnTop });
  const thumbColumns: PlateRect[] = [
    {
      side: 'left',
      x: lcol.x,
      y: lcol.y,
      width: THUMB_COLUMN_W,
      height: columnH,
      radius: 3.5,
    },
    {
      side: 'right',
      x: mirrorX(lcol.x + THUMB_COLUMN_W),
      y: lcol.y,
      width: THUMB_COLUMN_W,
      height: columnH,
      radius: 3.5,
    },
  ];

  const lh = toLeft(left.hinge);
  const hingeBumps: HingeBump[] = [
    { side: 'left', x: lh.x, y: lh.y, radius: HINGE_R },
    { side: 'right', x: mirrorX(lh.x), y: lh.y, radius: HINGE_R },
  ];

  const leftFiller = left.filler.map(toLeft);
  const thumbFillers: PhysicalLayout['thumbFillers'] = [
    { side: 'left', points: leftFiller },
    { side: 'right', points: leftFiller.map((p) => ({ x: mirrorX(p.x), y: p.y })) },
  ];

  // 帯（親指プレート）の上辺 y を x 位置から線形補間で求める。両端は
  // 端のセグメントを延長して外挿。
  const bandTopAt = (x: number): number | null => {
    const line = left.thumbLine;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      if (!a || !b || a.x === b.x) continue;
      const within = x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x);
      const before = i === 0 && x < Math.min(a.x, b.x);
      const after = i === line.length - 2 && x > Math.max(a.x, b.x);
      if (within || before || after) {
        const t = (x - a.x) / (b.x - a.x);
        return a.y + (b.y - a.y) * t - THUMB_PLATE_W / 2;
      }
    }
    return null;
  };

  // メインプレート: 列ごとの丸角ストリップ（重ねてスタッガー輪郭を作る）。
  // 底辺はキャップ被覆を最低限確保しつつ帯の上辺に MAIN_THUMB_GAP で追従。
  const mainPlates: PlateRect[] = [];
  for (let col = 0; col < MAIN_COL_X.length; col++) {
    const topKey = left.keys.find((k) => k.col === col && k.row === 0);
    if (!topKey) continue;
    const w = KEY_W + PLATE_PAD * 2;
    const topEdge = topKey.y - KEY_H / 2 - PLATE_PAD;
    const capBottom = topKey.y + ROW_PITCH * 2 + KEY_H / 2 + PLATE_PAD;
    const bandTop = col >= 1 ? bandTopAt(topKey.x) : null;
    const bottomEdge =
      bandTop === null ? capBottom : Math.max(capBottom, bandTop - MAIN_THUMB_GAP);
    const p = toLeft({ x: topKey.x, y: topEdge });
    const leftRect: PlateRect = {
      side: 'left',
      x: p.x - w / 2,
      y: p.y,
      width: w,
      height: bottomEdge - topEdge,
      radius: 3.5,
    };
    mainPlates.push(leftRect, {
      ...leftRect,
      side: 'right',
      x: mirrorX(p.x) - w / 2,
    });
  }

  const leftLine = left.thumbLine.map(toLeft);
  const thumbPlates: ThumbPlate[] = [
    { side: 'left', points: leftLine, width: THUMB_PLATE_W },
    {
      side: 'right',
      points: leftLine.map((p) => ({ x: mirrorX(p.x), y: p.y })),
      width: THUMB_PLATE_W,
    },
  ];

  return {
    widthMm,
    heightMm,
    keyWidthMm: KEY_W,
    keyHeightMm: KEY_H,
    keys,
    balls,
    xiaos,
    mainPlates,
    thumbPlates,
    thumbColumns,
    thumbFillers,
    hingeBumps,
  };
}

/** 実機ビューが描けるのは kobu の 4x10 マトリクスだけ。 */
export function isKobuMatrix(matrix: { rows: number; cols: number }): boolean {
  return matrix.rows === 4 && matrix.cols === 10;
}
