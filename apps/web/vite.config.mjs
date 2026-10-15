// Builds the dashboard (apps/web) into dist/, which web.js serves behind the login. Dev-only tooling: the bot never loads it.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: false, // PWA files in public/ are served by web.js, not copied into the build
  build: { outDir: 'dist', emptyOutDir: true },
  server: { fs: { allow: ['../..'] }, proxy: { '/api': 'http://127.0.0.1:8787' } }, // the dashboard imports ../server/dca.mjs (the bot's own order math)
});
