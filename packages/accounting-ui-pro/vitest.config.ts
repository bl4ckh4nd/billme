import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['../../apps/pro-desktop/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
