import { defineConfig } from '@playwright/test';

const isFull = process.env.E2E_FULL === '1';
const e2eTarget = process.env.E2E_TARGET === 'server' || process.env.E2E_SERVER_MODE === '1' ? 'server' : 'desktop';
const isServerMode = e2eTarget === 'server';
if (process.env.E2E_SERVER_DEBUG === '1') {
  console.error('[playwright-config]', JSON.stringify({ isFull, e2eTarget, isServerMode }));
}

const desktopSmokeProjects = [
  {
    name: 'desktop-smoke',
    testDir: './tests/e2e/desktop',
    testMatch: ['smoke.spec.mjs'],
  },
  {
    name: 'pro-smoke',
    testDir: './tests/e2e/pro',
    testMatch: ['pro-smoke.spec.mjs'],
  },
];

const desktopFullProjects = [
  {
    name: 'desktop-full',
    testDir: './tests/e2e/desktop',
    testMatch: '**/*.spec.mjs',
  },
  {
    name: 'pro-full',
    testDir: './tests/e2e/pro',
    testMatch: '**/*.spec.mjs',
  },
];

const serverSmokeProjects = [
  {
    name: 'server-docker-smoke',
    testDir: './tests/e2e/server',
    testMatch: ['stack-smoke.spec.mjs'],
  },
  {
    name: 'server-lite-smoke',
    testDir: './tests/e2e/server/lite',
    testMatch: ['smoke.spec.mjs'],
    dependencies: ['server-docker-smoke'],
  },
  {
    name: 'server-pro-smoke',
    testDir: './tests/e2e/server/pro',
    testMatch: ['smoke.spec.mjs'],
    dependencies: ['server-docker-smoke'],
  },
];

const serverFullProjects = [
  {
    name: 'server-docker-smoke',
    testDir: './tests/e2e/server',
    testMatch: ['stack-smoke.spec.mjs'],
  },
  {
    name: 'server-lite-full',
    testDir: './tests/e2e/server/lite',
    testMatch: '**/*.spec.mjs',
    dependencies: ['server-docker-smoke'],
  },
  {
    name: 'server-pro-full',
    testDir: './tests/e2e/server/pro',
    testMatch: '**/*.spec.mjs',
    dependencies: ['server-docker-smoke'],
  },
];

export default defineConfig({
  testDir: isServerMode ? './tests/e2e/server' : './tests/e2e',
  globalSetup: './tests/e2e/global-setup.mjs',
  timeout: isServerMode ? 180_000 : 120_000,
  fullyParallel: !isServerMode,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: isServerMode ? 1 : isFull ? 1 : process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  projects: isServerMode
    ? isFull
      ? serverFullProjects
      : serverSmokeProjects
    : isFull
      ? desktopFullProjects
      : desktopSmokeProjects,
});
