/// <reference types="vitest/config" />

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Vitest's default `exclude` already covers `node_modules` and
    // `dist`, but not `.direnv` — direnv copies flake inputs (full
    // nixpkgs sources, etc.) underneath it and they contain their
    // own tests we definitely do not want to run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.direnv/**'],
  },
});
