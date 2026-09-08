import { expect, test } from '@playwright/test';
import {
  runProAccountingScenario,
  runProAuthRestoreScenario,
  runProCatalogScenario,
  runProRouteGuardScenario,
} from './scenarios.mjs';
import { runProOutgoingDocumentChainScenario } from './outgoing-document-chain.mjs';

test.describe('server-mode pro web shell', () => {
  test.describe.configure({ mode: 'serial' });

  test('bootstraps or logs in the pro owner and restores the requested accounting route', async ({ page }) => {
    await runProAuthRestoreScenario(page);
  });

  test('covers catalog creation flows for seeded pro tenants', async ({ page }) => {
    await runProCatalogScenario(page);
  });

  test('exercises accounting tax endpoints, rule maintenance, and workflow persistence', async ({ page }) => {
    await runProAccountingScenario(page);
  });

  test('clears wrong-product sessions and preserves the protected route through re-login', async ({ page }) => {
    await runProRouteGuardScenario(page);
  });

  test('persists the accepted-offer outgoing chain and hosted Pro correction posting', async ({ page }) => {
    test.slow();
    await runProOutgoingDocumentChainScenario(page);
  });
});
