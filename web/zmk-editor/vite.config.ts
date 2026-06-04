/// <reference types="vitest/config" />

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// kobu-zmk-editor is a pure client-side SPA. All real work happens over
// the ZMK Studio RPC protocol via Web Serial (USB) / Web Bluetooth (BLE),
// which are local — no app server. It is served at the `/zmk` subpath of
// the existing kobu-editor Cloudflare Worker (see web/worker/index.ts),
// so the base must match. The Worker also serves the SPA fallback and the
// firmware-build endpoints; this dev config only needs the GitHub release
// proxy so the install flow works under `vite dev`.
export default defineConfig({
  base: '/zmk/',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // GitHub Release downloads + the Actions artifact proxy are served
      // by the Worker in production. In `vite dev` we only have the
      // release proxy (artifact builds need the real Worker + token).
      '/__release': {
        target: 'https://github.com',
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path) => path.replace(/^\/__release/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.direnv/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/test/**', 'src/**/*.d.ts', 'src/**/*.test.{ts,tsx}'],
    },
  },
});
