#!/usr/bin/env python3
"""Lint vial.json / keyboard.toml consistency for kobu.

Run from the repo root:
    python3 firmware/rmk/scripts/lint_keymap_config.py

Exits non-zero on the first inconsistency. Designed to catch the
classes of bugs the Vial-support issue series surfaced:

* vial.json matrix size diverging from keyboard.toml [layout]
* customKeycodes count drifting away from
  `ble_profiles_num + 4` (BT0..BTn-1 + Next + Prev + Clear + Switch)
* Per-RMK-0.8 wiring, user keycodes on layers must land within
  range [User0, User(ble_profiles_num + 3)] to be meaningful
* vial.json customKeycodes shortName labels exceeding the per-line
  width vial.rocks renders without cropping
"""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

# vial.rocks renders each line of shortName in a fixed-size cell. The
# UI starts cropping at roughly 8 characters per line for the default
# kle cap width. We err on the conservative side; the threshold may
# need tuning once issue #8 has live screenshots.
SHORT_NAME_MAX_PER_LINE = 8

# customKeycodes layout expected by rmk 0.8's process_user:
#   User0..User(N-1) → switch to BLE profile 0..N-1
#   User(N)          → next profile
#   User(N+1)        → previous profile
#   User(N+2)        → clear bond
#   User(N+3)        → toggle USB / BLE output
# where N = ble_profiles_num.
USER_KEYCODES_AFTER_PROFILES = 4

# This script lives at firmware/rmk/scripts/; the RMK firmware root (holding
# vial.json + keyboard.toml) is two levels up.
RMK = Path(__file__).resolve().parents[1]
VIAL = RMK / "vial.json"
TOML = RMK / "keyboard.toml"


def err(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)


def check_matrix_consistency(vial: dict, toml: dict, issues: list[str]) -> None:
    v_rows = vial["matrix"]["rows"]
    v_cols = vial["matrix"]["cols"]
    t_rows = toml["layout"]["rows"]
    t_cols = toml["layout"]["cols"]
    if (v_rows, v_cols) != (t_rows, t_cols):
        issues.append(
            f"matrix size mismatch: vial.json={v_rows}x{v_cols}, "
            f"keyboard.toml={t_rows}x{t_cols}"
        )


def check_keymap_dimensions(toml: dict, issues: list[str]) -> None:
    rows = toml["layout"]["rows"]
    cols = toml["layout"]["cols"]
    layers = toml["layout"]["layers"]
    keymap = toml["layout"]["keymap"]
    if len(keymap) != layers:
        issues.append(
            f"[layout].keymap has {len(keymap)} layers but [layout].layers={layers}"
        )
    for li, layer in enumerate(keymap):
        if len(layer) != rows:
            issues.append(f"layer {li} has {len(layer)} rows, expected {rows}")
            continue
        for ri, row in enumerate(layer):
            if len(row) != cols:
                issues.append(
                    f"layer {li} row {ri} has {len(row)} cols, expected {cols}"
                )


def check_custom_keycodes(vial: dict, toml: dict, issues: list[str]) -> None:
    rmk = toml.get("rmk", {})
    profiles = rmk.get("ble_profiles_num")
    if profiles is None:
        return
    expected = profiles + USER_KEYCODES_AFTER_PROFILES
    actual = len(vial.get("customKeycodes", []))
    if actual != expected:
        issues.append(
            f"customKeycodes count = {actual}, expected {expected} "
            f"(ble_profiles_num = {profiles} + 4 control keycodes)"
        )


def check_shortname_widths(vial: dict, issues: list[str]) -> None:
    for entry in vial.get("customKeycodes", []):
        short = entry.get("shortName", "")
        for line in short.split("\n"):
            if len(line) > SHORT_NAME_MAX_PER_LINE:
                issues.append(
                    f"customKeycode {entry.get('name', '?')!r} shortName "
                    f"line {line!r} is {len(line)} chars > "
                    f"{SHORT_NAME_MAX_PER_LINE}; may crop in vial.rocks"
                )


def check_user_keycode_range(toml: dict, issues: list[str]) -> None:
    rmk = toml.get("rmk", {})
    profiles = rmk.get("ble_profiles_num")
    if profiles is None:
        return
    max_meaningful = profiles + USER_KEYCODES_AFTER_PROFILES - 1
    for li, layer in enumerate(toml["layout"]["keymap"]):
        for ri, row in enumerate(layer):
            for ci, cell in enumerate(row):
                if not isinstance(cell, str) or not cell.startswith("User"):
                    continue
                rest = cell[4:]
                if not rest.isdigit():
                    continue
                idx = int(rest)
                if idx > max_meaningful:
                    issues.append(
                        f"layer {li} ({ri},{ci}) = {cell} exceeds last "
                        f"meaningful user keycode User{max_meaningful} "
                        f"(ble_profiles_num={profiles})"
                    )


def main() -> int:
    try:
        vial = json.loads(VIAL.read_text())
    except (OSError, json.JSONDecodeError) as e:
        err(f"failed to load vial.json: {e}")
        return 1

    try:
        with TOML.open("rb") as f:
            toml = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        err(f"failed to load keyboard.toml: {e}")
        return 1

    issues: list[str] = []
    check_matrix_consistency(vial, toml, issues)
    check_keymap_dimensions(toml, issues)
    check_custom_keycodes(vial, toml, issues)
    check_shortname_widths(vial, issues)
    check_user_keycode_range(toml, issues)

    if issues:
        for i in issues:
            err(i)
        print(f"\nlint failed with {len(issues)} issue(s)", file=sys.stderr)
        return 1

    print("ok: vial.json and keyboard.toml are mutually consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
