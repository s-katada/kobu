# kobu-config (web app)

Web-based keymap editor for the [kobu](../) split keyboard, served as a
single-page app. Talks to kobu's central half over USB or BLE-HoG via
the WebHID API and the Vial wire protocol — no native install, no
driver required.

Lives inside the kobu monorepo. Firmware at [`../firmware/`](../firmware/),
hardware at [`../pcb/`](../pcb/).

## What you can do with it

| Feature | Status |
|---|---|
| Read / write keymap (4 layers × 4×10 matrix) | ✅ |
| Categorised keycode picker (basic / mods / layers / mouse / media / kobu-specific BT keys) | ✅ |
| Layer 3 dedicated BLE-profile panel | ✅ |
| Macros (Vial advanced format — tap / press / release / delay) | ✅ |
| Combos (up to 4 input keys → 1 output key, ×16 slots) | ✅ |
| Tap-dance (tap / hold / double-tap / hold-after-tap + per-entry tap-term) | ✅ |
| Firmware install from latest GitHub Release (UF2 + clean install) | ✅ |
| PWA / offline support (install as an app, works without network) | ✅ |
| Unsupported-browser splash with download recommendations | ✅ |
| Trackball / scroll / LED tuning panel | 🚧 see #39, #40 |

## Browser support

WebHID is Chromium-only:

| Platform | Supported browsers |
|---|---|
| Desktop (macOS / Windows / Linux) | Chrome, Edge, Brave, Opera, Vivaldi |
| Android | Chrome (USB-OTG cable required for kobu) |
| iOS | ❌ — all iOS browsers use WebKit; no WebHID |
| Safari (any version) | ❌ |
| Firefox (any version) | ❌ |

The app detects the environment on load and shows a dedicated splash
explaining what to install if WebHID is missing.

## User guide

### First-time setup

1. Connect kobu's **central half** (left half) to your computer with a
   data-capable USB-C cable. The peripheral half does not need to be
   connected.
2. Open the kobu-config URL in Chrome (or another Chromium browser).
3. Click **「kobu に接続」** ("Connect to kobu"). The browser pops up a
   device-picker — select kobu and click *Connect*.
4. The editor loads your current keymap from the device.

> **BLE editing works too**: once kobu is paired in your OS Bluetooth
> settings, Chrome's WebHID picker on macOS / Android / some Linux
> distros surfaces the BLE-paired kobu just like a USB device. Windows
> often requires USB because its HID stack doesn't always expose BLE
> HID devices.

### Editing keys

1. Click a key on the SVG matrix.
2. Pick a new keycode from the picker (search box + categorised tabs).
3. Click **「保存」** ("Save"). The editor will only persist if the
   firmware is **unlocked** (see below).
4. The amber dot on the layer tab fades as the firmware confirms each
   write.

### Unlocking the firmware

Vial firmwares ship locked — you have to physically hold a key
**chord** to prove you have the keyboard in front of you before
writes are accepted. For kobu the chord is the **two outermost pinky
keys** (`row 0, col 0` and `row 0, col 9` in the matrix — the Q and P
positions on a default QWERTY layout).

If you ever remap those positions to other keycodes, the chord is
still the *matrix* position, not the logical key — the unlock is
unaffected.

### Macros / combos / tap-dance

Scroll past the keymap section to find dedicated panels for each. All
three open the same keycode picker for individual fields, so the
familiar shortcuts apply.

### Firmware install

The **「ファームウェア」** section at the bottom of the page fetches
the latest UF2 from the kobu GitHub release and writes it via the
File System Access API (also Chromium-only). Two flows:

- **通常インストール** — overlay the new firmware; keeps your existing
  keymap.
- **クリーンインストール** — also resets the saved keymap to the
  firmware's build-time default. Useful when migrating between
  firmware versions that change the matrix shape.

Both flows do *not* touch BLE pairings.

## FAQ

**Q. Safari で動きません.**
A. WebHID API がないので動きません。Chromium 系（Chrome / Edge /
Brave / Opera）をインストールしてください。iOS の Chrome も実は
WebKit エンジンなので動きません — 別のデバイスを使ってください。

**Q. kobu に接続を押しても何も出てきません.**
A. データ通信非対応の USB ケーブル（充電専用ケーブル）の可能性が
あります。データ対応ケーブルに差し替えて再試行してください。

**Q. デバイスは選択できるけど "デバイスがロックされています" と出ます.**
A. 物理 unlock chord（両外側 pinky 同時押し）が必要です。`(0, 0)` と
`(0, 9)` の matrix 位置を同時に押し、押したまま「保存」してください。
詳細はリポジトリ root の [README.md](../README.md#unlock-chord) を
参照。

**Q. BLE 経由で繋がりません.**
A. macOS / Android / 一部 Linux なら、OS Bluetooth 設定で kobu を
ペアリング済みなら Chrome の WebHID ピッカーに出ます。Windows の HID
スタックは BLE HID デバイスを surface しないことが多く、その場合は
USB ケーブルで接続してください。

**Q. インストールしたのに次回も「初回ロード中」と出ます.**
A. PWA としてインストールしてもブラウザがキャッシュを別途消すと再
ロードが走ります。ホーム画面アイコンから開いてもキャッシュが消えて
いれば最初の HTML/JS フェッチだけは必要です。

**Q. 設定をやり直したい.**
A. ヘッダー右の "切断" を押し、もう一度接続すると最新の状態を読み
直します。完全に出荷状態に戻したい場合は firmware section の
"Reset" を使うか、`keyboard.toml` の `clear_layout = true` で再
フラッシュしてください（BLE ペアリングごと消すなら `clear_storage`）。

## Develop

The kobu nix devshell provides Node and pnpm — the same versions CI
uses. Enter it from the **repo root** (one level up from this
directory) or rely on direnv if you have nix-direnv installed:

```sh
nix develop                # at the kobu repo root, or
cd web && nix develop ..#web

pnpm install               # one-time
pnpm dev                   # http://localhost:5173
pnpm test                  # vitest
pnpm lint                  # biome
pnpm typecheck             # tsc -b --noEmit
pnpm build                 # production bundle in dist/
```

`flake.nix` pins Node 26 and pnpm. Bumping the Node major is a
one-line change in `../flake.nix` and CI picks it up automatically —
local dev and CI cannot drift.

### Cloudflare Workers (production hosting)

The SPA ships as a Cloudflare Worker that serves the Vite-built
`dist/` directory plus a `/__release` proxy to GitHub (so the
firmware-install flow can download UF2 binaries without CORS pain).
Locally:

```sh
pnpm cf:dev      # wrangler dev
pnpm cf:deploy   # build + wrangler deploy   (needs API token)
pnpm cf:tail     # tail production logs
```

CI deploys to production automatically on every push to `main` once
the lint / typecheck / test / build steps succeed. This requires two
**repository secrets** in GitHub:

- `CLOUDFLARE_API_TOKEN` — token scoped to *Edit Workers Scripts* +
  *Account → Workers KV Storage*.
- `CLOUDFLARE_ACCOUNT_ID` — your CF account id (visible in the
  dashboard URL).

The Worker also attaches a strict Content-Security-Policy and a
`Permissions-Policy` that grants `hid` only to our origin. The
`/__release` proxy keeps GitHub's response headers unmodified.

## Architecture (high-level)

```
        ┌────────────────────────────────────────────────────┐
  App ──┤  React 19 + Tailwind 4 + Zustand 5                 │
        │  ─────────────────────────────────────────────     │
        │  ConnectButton    KeymapView      KeycodePicker    │
        │  EditorToolbar    MacroEditor     ComboEditor      │
        │  MorseEditor      BluetoothPanel  FirmwareSection  │
        │  PwaUpdateToast   UnsupportedBrowserSplash         │
        └───────────────┬────────────────────────────────────┘
                        │
                        ▼  state/
        ┌────────────────────────────────────────────────────┐
        │  connection · editor · macros · combos · morses    │
        │  firmware                                          │
        └───────────────┬────────────────────────────────────┘
                        │
                        ▼  protocol/
        ┌────────────────────────────────────────────────────┐
        │  handshake · keymap · macros · combos · morses     │
        │  unlock · cache · commands (32-byte Vial packets)  │
        └───────────────┬────────────────────────────────────┘
                        │
                        ▼  transport/
        ┌────────────────────────────────────────────────────┐
        │  WebHidTransport (navigator.hid + ViaReport HID    │
        │                   collection 0xFF60/0x61)          │
        └────────────────────────────────────────────────────┘
                        │
                        ▼
                     ┌──────┐
                     │ kobu │  RMK 0.8 firmware
                     └──────┘
```

Decisions log: [#21](https://github.com/s-katada/kobu/issues/21).
Roadmap meta: [#41](https://github.com/s-katada/kobu/issues/41).

## Tech stack

- React 19 + TypeScript (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`)
- Vite 8 + Rolldown (build / dev server)
- Tailwind CSS 4 (utility styling)
- Zustand 5 (state management)
- Biome 2 (lint + format)
- Vitest 4 (unit + component tests, jsdom)
- vite-plugin-pwa + workbox (offline support)
- Cloudflare Workers + wrangler (production hosting)

## License

GPL-2.0-or-later — chosen pre-emptively to allow borrowing
protocol-layer code from upstream Vial projects. Will revisit if it
turns out we wrote the protocol layer from scratch.
