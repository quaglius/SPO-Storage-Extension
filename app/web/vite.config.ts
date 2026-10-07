import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const sharedSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/src/index.ts');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@spostorage/shared': sharedSrc,
    },
  },
  server: {
    // PORT lets dev-preview tooling assign a free port; 5173 remains the default.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': 'http://localhost:4180',
    },
  },
});
