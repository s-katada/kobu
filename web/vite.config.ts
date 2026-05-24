/// <reference types="vitest/config" />

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // kobu-editor is a pure client-side app — all real work happens
    // over WebHID, which is local. Once the bundle is cached, the
    // editor works offline. `registerType: 'prompt'` surfaces a toast
    // when a new SW is ready instead of silently reloading mid-edit.
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'kobu-editor',
        short_name: 'kobu-editor',
        description: 'Web keymap editor for the kobu split keyboard. Works offline once installed.',
        theme_color: '#863bff',
        background_color: '#fafafa',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        lang: 'ja',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Precache everything the build emits. We don't need a runtime
        // cache — WebHID does not hit the network, and the only fetch
        // we make (UF2 download for firmware install) intentionally
        // bypasses the SW so users always get the latest GitHub
        // release.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/__release/],
        runtimeCaching: [],
        // ~5 MB ceiling per asset; the bundle is ~300 kB so this is
        // headroom, but keep it explicit so the build fails loudly if
        // we ever ship a giant chunk by accident.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        // The SW is annoying in dev (intercepts HMR), but enabling it
        // lets us smoke-test the update flow without a full build.
        enabled: false,
      },
    }),
  ],
  // GitHub Release downloads don't return Access-Control-Allow-Origin,
  // so fetching uf2 binaries directly from the browser fails CORS.
  // In dev mode we route the install flow through `/__release/...`,
  // which the dev server proxies to github.com server-side (CORS does
  // not apply between server and origin). Production needs a real
  // solution — see the open issue tracking same-origin deployment.
  server: {
    proxy: {
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
    // Vitest's default `exclude` already covers `node_modules` and
    // `dist`, but not `.direnv` — direnv copies flake inputs (full
    // nixpkgs sources, etc.) underneath it and they contain their
    // own tests we definitely do not want to run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.direnv/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx', // bootstrap only
        'src/test/**',
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
      ],
    },
  },
});
