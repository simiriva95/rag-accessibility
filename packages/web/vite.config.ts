import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // data/ holds only what the site serves — the normalized corpus and the
  // generated indexes — so it is the public directory outright. The scraped
  // HTML lives in .cache/, because it is a cache and not a deliverable.
  publicDir: resolve(import.meta.dirname, '../../data'),
  build: { target: 'es2023' },
});
