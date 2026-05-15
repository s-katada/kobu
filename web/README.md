# kobu-config (web app)

Web-based keymap editor for the kobu split keyboard, served as a single-page
app. Talks to kobu's central half over USB via the WebHID API and the Vial
wire protocol — no native install, no driver required.

The web app lives inside the kobu monorepo. Firmware is at
[`../firmware/`](../firmware/), hardware at [`../pcb/`](../pcb/).

## Status

Phase 0–2 of the roadmap is in. Transport, full Vial protocol layer
(handshake / keymap / unlock / reset), and a minimal "connect & show
metadata" UI. Phase 3 (the actual keymap editor UI) is still to do —
see the open issues under the `kobu-config` label.

## Browser support

WebHID is Chromium-only. Use Chrome / Edge / Brave / Opera on desktop or
Chrome on Android (USB-OTG). Safari and Firefox cannot run this app.

## Develop

The kobu nix devshell provides Node and pnpm — the same versions CI uses.
Enter it from the **repo root** (one level up from this directory):

```sh
nix develop                # at the kobu repo root

cd web
pnpm install
pnpm dev      # http://localhost:5173
pnpm test     # vitest
pnpm lint     # biome
pnpm build    # production bundle in dist/
```

`flake.nix` pins Node 26 and pnpm. Bumping the Node major is a one-line
change in `../flake.nix` and CI picks it up automatically — local dev and
CI cannot drift.

## Tech stack

- React 19 + TypeScript (strict)
- Vite 8 (build / dev server)
- Tailwind CSS 4 (utility styling)
- Zustand 5 (state management)
- Biome 2 (lint + format)
- Vitest 4 (unit tests, jsdom)

Decisions log: [#21](https://github.com/s-katada/kobu/issues/21).
Roadmap meta: [#41](https://github.com/s-katada/kobu/issues/41).

## License

GPL-2.0-or-later — chosen pre-emptively to allow borrowing protocol-layer
code from upstream Vial projects. Will revisit if it turns out we write the
protocol layer from scratch.
