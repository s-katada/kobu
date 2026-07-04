import { describe, expect, it } from 'vitest';
import { isKobuMatrix, kobuPhysicalLayout } from './kobuPhysical';

describe('kobuPhysicalLayout', () => {
  const layout = kobuPhysicalLayout();

  it('has 38 keys (15+4 per half) with unique matrix positions', () => {
    expect(layout.keys).toHaveLength(38);
    const seen = new Set(layout.keys.map((k) => `${k.row},${k.col}`));
    expect(seen.size).toBe(38);
    expect(layout.keys.filter((k) => k.side === 'left')).toHaveLength(19);
    expect(layout.keys.filter((k) => k.side === 'right')).toHaveLength(19);
  });

  it('omits the phantom thumb slots (3,0) and (3,9)', () => {
    expect(layout.keys.find((k) => k.row === 3 && k.col === 0)).toBeUndefined();
    expect(layout.keys.find((k) => k.row === 3 && k.col === 9)).toBeUndefined();
  });

  const at = (row: number, col: number) => {
    const key = layout.keys.find((k) => k.row === row && k.col === col);
    if (!key) throw new Error(`key (${row},${col}) missing`);
    return key;
  };

  it('orders left-half columns outer→inner and right-half inner→outer', () => {
    // 左: col 0 (Q) が最も左、col 4 (T) が内側。
    for (let c = 0; c < 4; c++) {
      expect(at(0, c).x).toBeLessThan(at(0, c + 1).x);
    }
    // 右: col 5 (Y, 内側) < col 9 (P, 最も右)。
    for (let c = 5; c < 9; c++) {
      expect(at(0, c).x).toBeLessThan(at(0, c + 1).x);
    }
    // 左半身はすべて右半身より左。
    expect(at(0, 4).x).toBeLessThan(at(0, 5).x);
  });

  it('mirrors the right half across the centerline', () => {
    for (const k of layout.keys.filter((k) => k.side === 'left')) {
      const m = at(k.row, 9 - k.col);
      expect(m.x + k.x).toBeCloseTo(layout.widthMm, 5);
      expect(m.y).toBeCloseTo(k.y, 5);
      expect(m.rot).toBeCloseTo(-k.rot, 5);
    }
  });

  it('reproduces the column stagger (middle column highest, pinky lowest)', () => {
    const topYs = [0, 1, 2, 3, 4].map((c) => at(0, c).y);
    const middle = topYs[2] ?? 0;
    for (const [c, y] of topYs.entries()) {
      if (c !== 2) expect(y).toBeGreaterThan(middle);
    }
    // ピンキー列は 12mm 落ちる。
    expect((topYs[0] ?? 0) - middle).toBeCloseTo(12, 5);
  });

  it('fans the thumb keys 0/10/20/30° with the innermost most rotated', () => {
    expect(at(3, 1).rot).toBeCloseTo(0, 1);
    expect(at(3, 2).rot).toBeCloseTo(10.1, 1);
    expect(at(3, 3).rot).toBeCloseTo(20, 1);
    expect(at(3, 4).rot).toBeCloseTo(30, 1);
    // 右半身は逆回転。
    expect(at(3, 5).rot).toBeCloseTo(-30, 1);
    expect(at(3, 8).rot).toBeCloseTo(-0, 1);
  });

  it('places one trackball per half, inboard of the thumb arc', () => {
    expect(layout.balls).toHaveLength(2);
    const left = layout.balls.find((b) => b.side === 'left');
    const right = layout.balls.find((b) => b.side === 'right');
    if (!left || !right) throw new Error('balls missing');
    expect(left.x).toBeLessThan(layout.widthMm / 2);
    expect(right.x).toBeGreaterThan(layout.widthMm / 2);
    // ミラー対称。
    expect(left.x + right.x).toBeCloseTo(layout.widthMm, 5);
    // 左ボールは内側カラム (T) より内側、最内親指キーより上。
    expect(left.x).toBeGreaterThan(at(0, 4).x);
    expect(left.y).toBeLessThan(at(3, 4).y);
  });

  it('places a mirrored hinge bump per half on the thumb plate edge', () => {
    expect(layout.hingeBumps).toHaveLength(2);
    const left = layout.hingeBumps.find((h) => h.side === 'left');
    const right = layout.hingeBumps.find((h) => h.side === 'right');
    if (!left || !right) throw new Error('hinge bumps missing');
    expect(left.x + right.x).toBeCloseTo(layout.widthMm, 5);
    expect(left.y).toBeCloseTo(right.y, 5);
    // タブは外側親指キー (3,1) の上、メインブロックとの継ぎ目側。
    expect(left.y).toBeLessThan(at(3, 1).y);
  });

  it('keeps every element inside the layout bounds', () => {
    const inBounds = (x: number, y: number) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(layout.widthMm);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(layout.heightMm);
    };
    for (const k of layout.keys) {
      // 回転を含むキャップ対角でも収まる余裕を見る。
      const r = Math.hypot(layout.keyWidthMm, layout.keyHeightMm) / 2;
      inBounds(k.x - r, k.y - r);
      inBounds(k.x + r, k.y + r);
    }
    for (const b of layout.balls) {
      inBounds(b.x - b.bezelRadius, b.y - b.bezelRadius);
      inBounds(b.x + b.bezelRadius, b.y + b.bezelRadius);
    }
    for (const x of layout.xiaos) {
      inBounds(x.x - x.width / 2, x.y - x.height / 2);
      inBounds(x.x + x.width / 2, x.y + x.height / 2);
    }
    for (const h of layout.hingeBumps) {
      inBounds(h.x - h.radius, h.y - h.radius);
      inBounds(h.x + h.radius, h.y + h.radius);
    }
    for (const c of layout.thumbColumns) {
      inBounds(c.x, c.y);
      inBounds(c.x + c.width, c.y + c.height);
    }
  });

  it('keeps the thumb column axis-aligned around the ball, mirrored', () => {
    expect(layout.thumbColumns).toHaveLength(2);
    const left = layout.thumbColumns.find((c) => c.side === 'left');
    const right = layout.thumbColumns.find((c) => c.side === 'right');
    const leftBall = layout.balls.find((b) => b.side === 'left');
    if (!left || !right || !leftBall) throw new Error('columns missing');
    // 柱はハウジング中心に揃う。
    expect(left.x + left.width / 2).toBeCloseTo(leftBall.x, 5);
    // ミラー対称。
    expect(left.x + right.x + left.width).toBeCloseTo(layout.widthMm, 5);
    expect(left.y).toBeCloseTo(right.y, 5);
  });
});

describe('kobuPhysicalLayout with bottomPinky (kobu2 / v2)', () => {
  const v1 = kobuPhysicalLayout();
  const v2 = kobuPhysicalLayout({ bottomPinky: true });

  const at = (row: number, col: number) => {
    const key = v2.keys.find((k) => k.row === row && k.col === col);
    if (!key) throw new Error(`key (${row},${col}) missing`);
    return key;
  };

  it('has 40 keys — v1 の 38 + 小指列最下段 (3,0)/(3,9)', () => {
    expect(v2.keys).toHaveLength(40);
    const seen = new Set(v2.keys.map((k) => `${k.row},${k.col}`));
    expect(seen.size).toBe(40);
    expect(at(3, 0)).toBeDefined();
    expect(at(3, 9)).toBeDefined();
  });

  it('places the new key one row pitch below the pinky column, unrotated, non-thumb', () => {
    const z = at(2, 0);
    const a = at(1, 0);
    const nk = at(3, 0);
    // 同じ列 x、既存の行ピッチどおり 1 段下（v2 ケース STL 実測と一致）。
    expect(nk.x).toBeCloseTo(z.x, 5);
    expect(nk.y - z.y).toBeCloseTo(z.y - a.y, 5);
    expect(nk.rot).toBeCloseTo(0, 5);
    expect(nk.thumb).toBe(false);
  });

  it('mirrors the right-hand new key across the centerline', () => {
    const left = at(3, 0);
    const right = at(3, 9);
    expect(left.x + right.x).toBeCloseTo(v2.widthMm, 5);
    expect(right.y).toBeCloseTo(left.y, 5);
  });

  it('keeps the canvas size identical to v1 (new keys fit inside existing bounds)', () => {
    expect(v2.widthMm).toBeCloseTo(v1.widthMm, 5);
    expect(v2.heightMm).toBeCloseTo(v1.heightMm, 5);
  });

  it('extends only the pinky-column main plates by one row pitch', () => {
    const leftPlates = (l: ReturnType<typeof kobuPhysicalLayout>) =>
      l.mainPlates.filter((p) => p.side === 'left').sort((a, b) => a.x - b.x);
    const v1Plates = leftPlates(v1);
    const v2Plates = leftPlates(v2);
    expect(v2Plates).toHaveLength(v1Plates.length);
    for (let i = 0; i < v1Plates.length; i++) {
      const grow = (v2Plates[i]?.height ?? 0) - (v1Plates[i]?.height ?? 0);
      expect(grow).toBeCloseTo(i === 0 ? 16 : 0, 5);
    }
  });

  it('does not disturb the thumb arc or trackballs', () => {
    expect(v2.keys.filter((k) => k.thumb)).toHaveLength(8);
    expect(v2.balls).toEqual(v1.balls);
    expect(v2.hingeBumps).toEqual(v1.hingeBumps);
  });
});

describe('isKobuMatrix', () => {
  it('accepts only the 4x10 kobu matrix', () => {
    expect(isKobuMatrix({ rows: 4, cols: 10 })).toBe(true);
    expect(isKobuMatrix({ rows: 4, cols: 12 })).toBe(false);
    expect(isKobuMatrix({ rows: 5, cols: 10 })).toBe(false);
  });
});
