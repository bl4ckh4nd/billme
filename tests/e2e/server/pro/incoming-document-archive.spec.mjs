import { test } from '@playwright/test';
import { runProIncomingDocumentArchiveScenario } from './incoming-document-archive.mjs';

test('archives, reviews, downloads, and reloads incoming invoice originals in Pro Web', async ({ page }) => {
  test.slow();
  await runProIncomingDocumentArchiveScenario(page);
});
