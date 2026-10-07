import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@spostorage/shared': sharedSrc,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
