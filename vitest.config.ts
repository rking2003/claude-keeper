import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
