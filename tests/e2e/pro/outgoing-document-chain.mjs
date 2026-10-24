import process from 'node:process';
import { launchDesktopApp } from '../support.mjs';

// The shared scenario module is also the Playwright spec.  Suppressing only
// its test registration lets this direct harness execute the same assertions
// without Playwright Test's worker/global-setup lifecycle.
process.env.BILLME_DESKTOP_CHAIN_DIRECT_RUNNER = '1';
const { configureOutgoingPosting, runProDesktopOutgoingDocumentChainScenario, seedUnderRegularVat } = await import('./outgoing-document-chain.spec.mjs');

let desktop;
try {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedUnderRegularVat(desktop.page);
  await configureOutgoingPosting(desktop.page);
  const baselineAudit = await (await import('../support.mjs')).invokeDesktopIpc(desktop.page, 'audit:verify');
  if (!baselineAudit.ok) throw new Error(`Baseline audit chain is invalid: ${JSON.stringify(baselineAudit.errors)}`);
  await desktop.page.reload();
  await desktop.page.waitForFunction(() => Boolean(window.billmeApi));
  await runProDesktopOutgoingDocumentChainScenario(desktop.page, desktop.baseUrl);
  console.log('PASS: Pro desktop outgoing document chain');
} catch (error) {
  console.error('FAIL: Pro desktop outgoing document chain');
  console.error(error);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch((error) => {
    console.error('FAIL: Pro desktop cleanup', error);
    process.exitCode = 1;
  });
}
