// Builds the dashboard (ui/) into dist/, which web.js serves behind the login. Dev-only tooling: the bot never loads it.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { fs: { allow: ['..'] }, proxy: { '/api': 'http://127.0.0.1:8787' } }, // ui/ imports ../dca.mjs (the bot's own order math)
});
