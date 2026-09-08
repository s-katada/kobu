#!/usr/bin/env python3
"""kobu2 pointer-loss report from a hidlog capture.

Usage: analyze.py hid_log.txt [--fast 8] [--window 60]

Groups the per-element HID values into reports (values within 1.5 ms belong to
one report), then measures how the RIGHT ball's motion reaches the Mac:
  * delivery interval mode (15 ms = one report per host connection event)
  * LOSS: in fast motion (preceding report |dx|+|dy| >= --fast counts, where an
    8 ms PMW3610 poll cannot yield a zero-motion frame) the fraction of host
    connection events that carried NO report
  * CONSERVATION: mean |dx|+|dy| of the report after a k-event gap relative to
    the report before it; ~k means the missed travel was carried (jitter only),
    ~1.0 means the travel was LOST (under-travel = もっさり)
  * per-window timeline, gap-length distribution, loss vs speed, wheel stats
"""
import argparse, collections, sys

ap = argparse.ArgumentParser()
ap.add_argument('log')
ap.add_argument('--fast', type=int, default=8, help='min |dx|+|dy| of the preceding report to count as fast motion')
ap.add_argument('--window', type=int, default=60, help='timeline window seconds')
ap.add_argument('--interval-ms', type=float, default=15.0, help='host connection interval')
a = ap.parse_args()

rows = []
for line in open(a.log):
    if line.startswith('#'):
        continue
    p = line.split()
    if len(p) != 5:
        continue
    rows.append((float(p[0]), int(p[2]), int(p[3]), int(p[4])))
if not rows:
    sys.exit('no data lines (was the logger allowed to open the device? see the # open result header)')

reports = []
cur = None
for t, up, u, v in rows:
    if up == 9:
        continue
    if cur and t - cur['t0'] < 0.0015:
        cur['vals'][(up, u)] = v
    else:
        cur = {'t0': t, 'vals': {(up, u): v}}
        reports.append(cur)

def mag(r):
    return abs(r['vals'].get((1, 0x30), 0)) + abs(r['vals'].get((1, 0x31), 0))

mot = [r for r in reports if mag(r) > 0]
whl = [r for r in reports if r['vals'].get((1, 0x38), 0) != 0 or r['vals'].get((12, 0x238), 0) != 0]
t0 = reports[0]['t0']
span = reports[-1]['t0'] - t0
print(f'capture: {span/60:.1f} min, {len(reports)} reports, {len(mot)} pointer-motion, {len(whl)} wheel/pan, '
      f'{sum(1 for r in rows if r[1]==9)} button events')

I = a.interval_ms
ivs = [(b['t0'] - m['t0']) * 1000 for m, b in zip(mot, mot[1:]) if (b['t0'] - m['t0']) * 1000 < 200]
hist = collections.Counter(round(d / 1.25) * 1.25 for d in ivs)
top = sorted(hist.items(), key=lambda x: -x[1])[:6]
print('delivery interval (intra-burst) top bins:', ', '.join(f'{k:.2f}ms:{c}' for k, c in top))

fast = [(m, b) for m, b in zip(mot, mot[1:]) if mag(m) >= a.fast and (b['t0'] - m['t0']) * 1000 < 200]
gaps = collections.Counter(max(1, round((b['t0'] - m['t0']) * 1000 / I)) for m, b in fast)
n = sum(gaps.values())
loss = sum(c for k, c in gaps.items() if k >= 2) / n if n else float('nan')
print(f'\nFAST MOTION (prev >= {a.fast} counts): n={n}, P(no report at a connection event) = {loss:.3f}')
print('  gap distribution (events):', ', '.join(f'{k}:{c/n:.3f}' for k, c in sorted(gaps.items()) if k <= 6))

byk = collections.defaultdict(list)
for m, b in fast:
    if mag(m) >= 12 and mag(b) >= 12:
        k = max(1, round((b['t0'] - m['t0']) * 1000 / I))
        byk[k].append(mag(b) / mag(m))
print('CONSERVATION (steady fast motion, both >= 12): ratio mag(after)/mag(before)')
for k in sorted(byk):
    if k <= 4:
        r = byk[k]
        print(f'  gap={k} events: n={len(r):4d} mean ratio={sum(r)/len(r):.2f}  (carried travel => ~{k}; lost => ~1)')

print('\nLOSS vs SPEED (|dx|+|dy| of preceding report):')
for lo, hi in [(a.fast, 11), (12, 19), (20, 39), (40, 9999)]:
    sel = [(m, b) for m, b in fast if lo <= mag(m) <= hi]
    if len(sel) < 30:
        continue
    l = sum(1 for m, b in sel if round((b['t0'] - m['t0']) * 1000 / I) >= 2) / len(sel)
    print(f'  {lo:3d}-{hi:<4d} n={len(sel):5d} loss={l:.3f}')

W = a.window
win = collections.defaultdict(lambda: [0, 0])
for m, b in fast:
    w = int((m['t0'] - t0) // W)
    win[w][0] += 1
    win[w][1] += round((b['t0'] - m['t0']) * 1000 / I) >= 2
print(f'\nTIMELINE (fast-motion loss per {W}s window; windows with >= 40 intervals)')
vals = []
for w in range(int(span // W) + 1):
    c, l = win.get(w, [0, 0])
    if c < 40:
        continue
    f = l / c
    vals.append(f)
    print(f'  {w*W:6d}s n={c:4d} loss={f:.3f} {"#"*int(f*100)}')
if vals:
    print(f'  windows={len(vals)} min={min(vals):.3f} max={max(vals):.3f} mean={sum(vals)/len(vals):.3f}'
          f'  first-half mean={sum(vals[:len(vals)//2])/max(1,len(vals)//2):.3f} second-half mean={sum(vals[len(vals)//2:])/max(1,len(vals)-len(vals)//2):.3f}')

wiv = [(b['t0'] - m['t0']) * 1000 for m, b in zip(whl, whl[1:]) if (b['t0'] - m['t0']) * 1000 < 200]
wh = collections.Counter(round(d / 1.25) * 1.25 for d in wiv)
print('\nWHEEL/PAN (left ball) intra-burst interval top bins:', ', '.join(f'{k:.2f}ms:{c}' for k, c in sorted(wh.items(), key=lambda x: -x[1])[:6]))
