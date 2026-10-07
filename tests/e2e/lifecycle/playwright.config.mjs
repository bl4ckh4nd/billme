import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({
  testDir: '.', testMatch: 'lifecycle.spec.mjs', workers: 1,
  outputDir: join(tmpdir(), 'billme-lifecycle-artifacts'),
  reporter: [['list'], ['json', { outputFile: join(tmpdir(), 'billme-lifecycle-results.json') }]],
  use: { baseURL: 'http://127.0.0.1:4189', trace: 'off', screenshot: 'on' },
  webServer: [
    { command: 'pnpm exec vite --config tests/e2e/lifecycle/vite.config.ts', cwd: '../../..', url: 'http://127.0.0.1:4189', reuseExistingServer: !process.env.CI },
    // Two real hosted APIs (PGlite) as server A and B; see servers.mts.
    { command: 'node --import tsx tests/e2e/lifecycle/servers.mts', cwd: '../../..', url: 'http://127.0.0.1:4192/health', reuseExistingServer: false, timeout: 120_000 },
  ],
});
