# kobu-config

Web-based keymap editor for the [kobu](https://github.com/s-katada/kobu) split keyboard.

Talks to kobu's central half over USB via the WebHID API and the Vial wire
protocol — no native install, no driver required. Runs entirely in the
browser as a single-page app.

## Status

Scaffold only — UI shows a placeholder "Connect" screen that detects WebHID
support but doesn't do anything yet. The Vial transport layer lands in
[s-katada/kobu#23](https://github.com/s-katada/kobu/issues/23). The full
roadmap lives at [s-katada/kobu#41](https://github.com/s-katada/kobu/issues/41).

## Browser support

WebHID is Chromium-only. Use Chrome / Edge / Brave / Opera on desktop or
Chrome on Android (USB-OTG). Safari and Firefox cannot run this app.

## Develop

```sh
pnpm install
pnpm dev      # http://localhost:5173
pnpm test     # vitest
pnpm lint     # biome
pnpm build    # production bundle in dist/
```

Requires Node 22+ and pnpm 11+.

## Tech stack

- React 19 + TypeScript (strict)
- Vite 8 (build / dev server)
- Tailwind CSS 4 (utility styling)
- Zustand 5 (state management)
- Biome 2 (lint + format)
- Vitest 4 (unit tests, jsdom)

The picks live in [s-katada/kobu#21](https://github.com/s-katada/kobu/issues/21).

## License

GPL-2.0-or-later — chosen pre-emptively to allow borrowing protocol-layer
code from upstream Vial projects. Will revisit if it turns out we write the
protocol layer from scratch.
