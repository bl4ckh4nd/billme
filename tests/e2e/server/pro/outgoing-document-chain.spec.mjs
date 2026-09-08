import { test } from '@playwright/test';
import { runProOutgoingDocumentChainScenario } from './outgoing-document-chain.mjs';

test('persists the accepted-offer outgoing chain and hosted Pro correction posting', async ({ page }) => {
  test.slow();
  await runProOutgoingDocumentChainScenario(page);
});
