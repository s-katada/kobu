# kobu — ZMK firmware

A ZMK port of kobu's firmware. The original RMK firmware is preserved in
[`../rmk/`](../rmk) (`firmware/rmk/`); this directory is the ZMK config. The
build is driven by the single repo-root [`flake.nix`](../../flake.nix) (via
`zmk-nix`), so **no west / Zephyr / SDK install is required**. `cd`-ing here
activates the `zmk` dev shell through [`.envrc`](.envrc).

The keymap, trackball behavior, BLE tuning and RGB-LED status are ported 1:1
from the RMK firmware (`../rmk/keyboard.toml`, `../rmk/src/*.rs`), which itself derives
from [KobitoKey_QWERTY](https://github.com/s-katada/KobitoKey_QWERTY) (ZMK).
kobu is a different PCB, so the matrix pins, the `row2col` diode direction and
the dual-trackball wiring are kobu-specific (see `config/boards/shields/kobu/`).

## Layout

```
firmware/zmk/
  .envrc                          # `use flake "path:../..#zmk"` (build shell)
  build.yaml                      # GitHub Actions matrix (CI parity; not used by Nix)
  config/
    west.yml                      # pins ZMK v0.3 + PMW3610 driver + rgbled-widget
    kobu.keymap                   # 7 layers, combos, behaviors (1:1 from RMK)
    boards/shields/kobu/
      kobu.dtsi                   # 4x10 matrix (row2col), split inputs, layout
      kobu_left.overlay           # central: SPI + left ball (scroll) + auto-mouse
      kobu_right.overlay          # peripheral: col override + right ball (pointer)
      kobu_left.conf / kobu_right.conf
      Kconfig.shield / Kconfig.defconfig
      kobu.zmk.yml
```

LEFT = central (local trackball → scroll). RIGHT = peripheral (trackball
forwarded over the split link → pointer + auto-mouse layer 4).

## Build (Nix)

The ZMK build is exposed by the repo-root flake (`packages.zmk*`), with
`zephyrDepsHash` already pinned, so a clean build just works (verified building
both halves + the reset image). Run from the **repo root**:

```sh
# Both halves + reset, named for kobu -> result/kobu-zmk-{left,right,reset}.uf2
nix build .#zmk-bundle
cp -L result/kobu-zmk-left.uf2  ./kobu-zmk-left.uf2
cp -L result/kobu-zmk-right.uf2 ./kobu-zmk-right.uf2
cp -L result/kobu-zmk-reset.uf2 ./kobu-zmk-reset.uf2

# Or just the two halves:  nix build .#zmk   -> result/zmk_{left,right}.uf2
# Or just the reset image: nix build .#zmk-reset
```

> Files must be tracked by git for the flake to see them (`git add firmware/zmk`).

If `firmware/zmk/config/west.yml` ever changes (ZMK / module revisions),
re-bootstrap the hash: set `zmkDepsHash = lib.fakeHash;` in the root `flake.nix`,
run `nix build .#zmk`, and paste the reported `got: sha256-...` back in.

## Flash

Double-tap the XIAO reset button; it mounts as a USB mass-storage volume. Copy
the matching UF2 onto it:

```sh
cp kobu-zmk-left.uf2  /Volumes/XIAO-SENSE/     # central / left half
cp kobu-zmk-right.uf2 /Volumes/XIAO-SENSE/     # peripheral / right half
```

`kobu-zmk-reset.uf2` clears BLE bonds + stored settings (flash it, then reflash
the normal half firmware).

## Fallback: manual west build

If you prefer raw west, the root flake's `zmk` dev shell provides the full
toolchain (auto-activated here via `.envrc`, or `nix develop .#zmk` from the
repo root):

```sh
cd firmware/zmk          # .envrc activates the zmk shell (or: nix develop ../..#zmk)
west init -l config
west update
west build -p -d build/left  -s zmk/app -b seeeduino_xiao_ble \
  -S studio-rpc-usb-uart \
  -- -DSHIELD="kobu_left rgbled_adapter" -DZMK_CONFIG="$PWD/config" -DZMK_EXTRA_MODULES="$PWD/config"
west build -p -d build/right -s zmk/app -b seeeduino_xiao_ble \
  -- -DSHIELD="kobu_right rgbled_adapter" -DZMK_CONFIG="$PWD/config" -DZMK_EXTRA_MODULES="$PWD/config"
cp -L build/left/zephyr/zmk.uf2  ../../kobu-zmk-left.uf2
cp -L build/right/zephyr/zmk.uf2 ../../kobu-zmk-right.uf2
```

## Keymap editing

ZMK Studio (over USB, central only) replaces kobu's RMK Vial/web editor.
`CONFIG_ZMK_STUDIO=y` is set on the central; connect at <https://zmk.studio>.

## Differences from the RMK firmware (faithful-port notes)

- Trackball **direction flags** (scroll roll-right = up; pointer Y-invert)
  depend on physical ball mounting — RMK exposes them as runtime flags. The ZMK
  defaults here match RMK's defaults; if scroll/pointer goes the wrong way on
  the bench, flip `INPUT_TRANSFORM_*` in the overlays (see comments).
- The RMK auto-mouse "travel gate" / sub-count keepalive are approximated by
  ZMK's `zip_temp_layer` (activate on motion after 300 ms prior-idle, 150 ms
  idle-deactivate); behavior is equivalent for normal use.
- RGB LED uses `zmk-rgbled-widget` (battery boot color + per-layer colors +
  connection status) instead of RMK's bespoke controller; layer colors match
  `../rmk/src/status_led.rs`.
