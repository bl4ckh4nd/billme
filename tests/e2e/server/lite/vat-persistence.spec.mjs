import { test } from '@playwright/test';
import { runLiteVatPersistenceScenario } from './scenarios.mjs';

test('persists per-line VAT through the Lite server API', async ({}, testInfo) => {
  await runLiteVatPersistenceScenario(`${testInfo.project.name}-${testInfo.title}`);
});
