# kobu ZMK editor

A web keymap editor for the **kobu** split keyboard running **ZMK**
firmware. It lives under `web/zmk-editor/` (the RMK editor in `web/rmk-editor/` is
left untouched) and is served at the `/zmk` subpath of the same site
(`kobu-editor.digletts.dev/zmk`).

Two things it does:

1. **Live keymap editing** over the **ZMK Studio** RPC protocol
   (USB Web Serial, or BLE Web Bluetooth on Linux). Reassign keys, manage
   layers, save to the keyboard — no reflash.
2. **Detailed settings** (trackball CPI, scroll/pointer scaling, hold-tap
   & tap-dance timing, combo timeout, auto-mouse timeout) → a parameterised
   **GitHub Actions build** → flash the resulting UF2 from the browser.

> **Why two modes?** In ZMK the keymap *layers/bindings* are runtime-editable
> (ZMK Studio stores them in settings), but behaviors, combos and trackball
> CPI are compiled into the firmware from devicetree at build time — there is
> no live-edit path for them. So the deep knobs require a rebuild. (Vial/RMK
> can do it live only because their keymap is an interpreted data blob.)

## What's editable where

| Setting | How |
| --- | --- |
| Per-key bindings, layers (add/remove/rename/reorder), save/discard, factory reset | **Live** (ZMK Studio) |
| Trackball CPI (L/R), pointer gain, scroll sensitivity | Build-time |
| Hold-tap / tap-dance tapping term, combo timeout, auto-mouse timeout | Build-time |
| Defining *new* behaviors / macros / combos | Edit `firmware/zmk/config/kobu.keymap` directly + rebuild |

## Browser support

Chromium only (Chrome / Edge / Brave / Opera). **USB (Web Serial)** is the
primary transport and works on every desktop OS. **BLE (Web Bluetooth)** is
only usable in-browser on Linux (a Chromium limitation). Firmware flashing
uses the File System Access API (Chromium).

## Architecture

```
src/
  rpc/         ZMK Studio transport + typed RPC session (@zmkfirmware/zmk-studio-ts-client)
    connect.ts   USB / BLE transport + ConnectError
    session.ts   StudioSession: typed RPC calls + notification loop
    types.ts     re-exported protobuf message types
  state/       Zustand stores
    connection.ts    connection state machine (owns the session)
    keymap.ts        layers, behaviors, live edits, undo/redo, save/discard
    buildSettings.ts detailed-settings values + build→flash flow
    firmware.ts      GitHub release fetch hook (install)
  keymap/      data + formatting
    physicalLayout.ts  kobu 40-key geometry (fallback; device reports its own)
    hidUsages.ts       HID usage encode/decode + labels + keycode palette
    binding.ts         device-metadata → key-cap label
    kobuDefaults.ts    stock keymap (offline preview) + dt-binding formatter
  config/
    settings.ts  build-time knob schema + override payload
    build.ts     client for the Worker build endpoints (+ fflate unzip)
  install/     UF2 flashing (File System Access API), ported from web/rmk-editor/
  components/  React UI (connect, keymap grid, layer bar, behavior picker, install, settings)
  lib/browser.ts  Chromium / transport detection
```

The grid and the behavior list are rendered from what the **device reports**
(`getPhysicalLayouts`, `listAllBehaviors` + `getBehaviorDetails`); the bundled
kobu data is only a fallback / offline preview.

## Develop

```sh
cd web/zmk-editor
nix develop ../..#web   # Node + pnpm (shared with the RMK editor)
pnpm install
pnpm dev             # http://localhost:5173/zmk/
pnpm test            # vitest
pnpm typecheck       # tsc -b --noEmit
pnpm lint            # biome
pnpm build           # tsc -b && vite build  → dist/  (base /zmk/)
```

USB/BLE work on `localhost` (a secure context). The firmware-build flow needs
the deployed Worker (it holds the GitHub token), so it can't be exercised from
`pnpm dev` alone.

## Deploy

This app has **no Worker of its own**. The sibling `web/rmk-editor/` Cloudflare
Worker serves it: the deploy (`.github/workflows/web.yml`) builds this app with
`base: /zmk/` into `web/rmk-editor/dist/zmk/`, and `web/rmk-editor/worker/index.ts`
serves `/zmk`
with the right `Permissions-Policy` (serial/bluetooth) and hosts the build
endpoints.

### Enabling the build pipeline (optional)

The detailed-settings build needs a GitHub token on the Worker so the browser
never holds one:

1. Create a **fine-grained PAT** for `s-katada/kobu` with
   `Actions: read and write` + `Contents: read`.
2. `cd web && wrangler secret put GITHUB_TOKEN` (paste the PAT).

Without it, the build endpoints return `501` and the UI shows
"build not configured" — live editing and manual firmware install still work.

Flow: browser `POST /zmk/__build` → Worker dispatches `firmware.yml`
(`workflow_dispatch` with a base64 overrides blob + a `build_id` echoed into
the run name) → `scripts/zmk-apply-overrides.py` patches
`firmware/zmk/config/*` → `nix build .#zmk-bundle` → the Worker proxies the run
artifact back → the browser unzips and flashes `kobu-zmk-left.uf2` / `kobu-zmk-right.uf2`.
