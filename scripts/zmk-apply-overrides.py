#!/usr/bin/env python3
"""Apply ZMK editor "detailed settings" overrides to firmware/zmk/config.

Reads a JSON file (the decoded `overrides_b64` workflow input) of the form

    { "overrides": { "left_cpi": 800, "tapping_term_ms": 180, ... },
      "build_id": "..." }

and patches the kobu devicetree/keymap in place so the subsequent
`nix build .#zmk-bundle` produces firmware with the chosen values.

Each edit targets a known property and FAILS LOUDLY (non-zero exit) if the
pattern is not found, so a silent no-op build never ships. Supported keys
and where they live:

    left_cpi               kobu_left.overlay     cpi = <N>;
    right_cpi              kobu_right.overlay    cpi = <N>;
    pointer_gain_x100      kobu_right.overlay    &zip_xy_scaler N 100
    scroll_divisor         kobu_left.overlay     &zip_scroll_scaler 1 N
    automouse_timeout_ms   kobu_left.overlay     &zip_temp_layer 4 N
    tapping_term_ms        kobu.keymap           tapping-term-ms = <N>;  (all)
    combo_timeout_ms       kobu.keymap           timeout-ms = <N>;       (all)

Usage:  zmk-apply-overrides.py <overrides.json> [--config-dir DIR]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Sanity bounds — the Worker already validates, but guard here too so a
# hand-run never writes a pathological value.
BOUNDS = {
    "left_cpi": (100, 3000),
    "right_cpi": (100, 3000),
    "pointer_gain_x100": (50, 300),
    "scroll_divisor": (5, 60),
    "require_prior_idle_ms": (0, 1000),
    "automouse_timeout_ms": (50, 600),
    "tapping_term_ms": (50, 500),
    "combo_timeout_ms": (10, 150),
}


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def clamp(key: str, value: int) -> int:
    lo, hi = BOUNDS[key]
    return max(lo, min(hi, int(value)))


def patch(path: Path, pattern: str, repl: str, label: str, count: int = 0) -> None:
    text = path.read_text()
    new, n = re.subn(pattern, repl, text, count=count)
    if n == 0:
        fail(f"pattern for '{label}' not found in {path}")
    path.write_text(new)
    print(f"  {label}: patched {n} site(s) in {path.name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("overrides_json")
    ap.add_argument("--config-dir", default="firmware/zmk/config")
    args = ap.parse_args()

    cfg = Path(args.config_dir)
    left = cfg / "boards/shields/kobu/kobu_left.overlay"
    right = cfg / "boards/shields/kobu/kobu_right.overlay"
    keymap = cfg / "kobu.keymap"
    for p in (left, right, keymap):
        if not p.exists():
            fail(f"config file missing: {p}")

    data = json.loads(Path(args.overrides_json).read_text())
    ov = data.get("overrides", {})
    if not isinstance(ov, dict) or not ov:
        print("no overrides — leaving config unchanged")
        return

    print(f"applying overrides (build_id={data.get('build_id', '?')}):")

    if "left_cpi" in ov:
        v = clamp("left_cpi", ov["left_cpi"])
        patch(left, r"cpi = <\d+>;", f"cpi = <{v}>;", "left_cpi", count=1)
    if "right_cpi" in ov:
        v = clamp("right_cpi", ov["right_cpi"])
        patch(right, r"cpi = <\d+>;", f"cpi = <{v}>;", "right_cpi", count=1)
    if "pointer_gain_x100" in ov:
        v = clamp("pointer_gain_x100", ov["pointer_gain_x100"])
        patch(right, r"&zip_xy_scaler \d+ \d+", f"&zip_xy_scaler {v} 100", "pointer_gain", count=1)
    if "scroll_divisor" in ov:
        v = clamp("scroll_divisor", ov["scroll_divisor"])
        patch(left, r"&zip_scroll_scaler 1 \d+", f"&zip_scroll_scaler 1 {v}", "scroll_divisor", count=1)
    if "require_prior_idle_ms" in ov:
        v = clamp("require_prior_idle_ms", ov["require_prior_idle_ms"])
        patch(left, r"require-prior-idle-ms = <\d+>;", f"require-prior-idle-ms = <{v}>;", "require_prior_idle", count=1)
    if "automouse_timeout_ms" in ov:
        v = clamp("automouse_timeout_ms", ov["automouse_timeout_ms"])
        patch(left, r"&zip_temp_layer 4 \d+", f"&zip_temp_layer 4 {v}", "automouse_timeout", count=1)
    if "tapping_term_ms" in ov:
        v = clamp("tapping_term_ms", ov["tapping_term_ms"])
        patch(keymap, r"tapping-term-ms = <\d+>;", f"tapping-term-ms = <{v}>;", "tapping_term")
    if "combo_timeout_ms" in ov:
        v = clamp("combo_timeout_ms", ov["combo_timeout_ms"])
        patch(keymap, r"timeout-ms = <\d+>;", f"timeout-ms = <{v}>;", "combo_timeout")

    print("done")


if __name__ == "__main__":
    main()
