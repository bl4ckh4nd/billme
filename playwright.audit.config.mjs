// ponytail: local audit runner without the global double rebuild (OOMs on this machine); build the apps first. Delete once global-setup can skip builds.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'desktop', testDir: './tests/e2e/desktop', testMatch: process.env.AUDIT_DESKTOP_SPECS?.split(',') ?? ['document-delivery.spec.mjs'] },
    { name: 'pro', testDir: './tests/e2e/pro', testMatch: process.env.AUDIT_PRO_SPECS?.split(',') ?? ['pro-bank-import.spec.mjs'] },
  ],
});
