import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { readServerHarnessState, startServerModeStack, stopServerModeStack } from './harness.mjs';
import { runStackSmokeScenario } from './scenarios.mjs';
import {
  runLiteAuthScenario,
  runLiteRegressionScenario,
  runLiteSmokeScenario,
  runLiteVatPersistenceScenario,
  runLiteWorkflowScenario,
} from './lite/scenarios.mjs';
import { runLiteCliScenario } from './lite/cli.mjs';
import { runWorkerFlowScenario } from './worker-flows.mjs';
import {
  runProAccountingScenario,
  runProAuthRestoreScenario,
  runProCatalogScenario,
  runProRouteGuardScenario,
  runProSmokeScenario,
} from './pro/scenarios.mjs';
import { runProNonHappyAccountingScenario } from './pro/nonhappy.mjs';
import { runProSourceRunScenario } from './pro/source-runs.mjs';
import { runProOutgoingDocumentChainScenario } from './pro/outgoing-document-chain.mjs';
import { runProIncomingDocumentArchiveScenario } from './pro/incoming-document-archive.mjs';

const level = process.argv[2] === 'full' ? 'full' : 'smoke';
const scope = process.argv[3] ?? 'all';
const headless = !(process.env.SERVER_E2E_HEADED === '1' || process.env.PW_HEADLESS === '0');

process.env.E2E_TARGET = 'server';
process.env.E2E_SCENARIO_IMPORT = '1';
if (level === 'full') {
  process.env.E2E_FULL = '1';
}

const { runProIncomingInvoiceUiScenario } = await import('./pro/incoming-invoice-ui.spec.mjs');

const buildScenarioList = () => {
  const scenarios = [];
  const includeNonHappy = level === 'full' && (scope === 'all' || scope === 'pro' || scope === 'pro-nonhappy');
  const includeStack = scope === 'all' || scope === 'stack' || scope === 'lite' || scope === 'pro';
  const includeLite = scope === 'all' || scope === 'lite';
  const includePro = scope === 'all' || scope === 'pro';

  if (includeStack) {
    scenarios.push({ name: 'stack-smoke', kind: 'plain', run: runStackSmokeScenario });
  }

  if (includeLite) {
    scenarios.push({ name: 'lite-smoke', kind: 'browser', run: runLiteSmokeScenario });
    if (level === 'full') {
      scenarios.push({ name: 'lite-auth', kind: 'browser', run: (page) => runLiteAuthScenario(page, 'runner-lite-auth') });
      scenarios.push({ name: 'lite-regressions', kind: 'browser', run: (page) => runLiteRegressionScenario(page, 'runner-lite-regressions') });
      scenarios.push({ name: 'lite-vat-persistence', kind: 'plain', run: () => runLiteVatPersistenceScenario('runner-lite-vat-persistence') });
      scenarios.push({ name: 'lite-workflow', kind: 'browser', run: (page) => runLiteWorkflowScenario(page, 'runner-lite-workflow') });
      scenarios.push({ name: 'lite-worker-flows', kind: 'plain', run: () => runWorkerFlowScenario('lite') });
    }
    // Last in the Lite list: it completes onboarding and turns on e-invoicing in the tenant the others share.
    scenarios.push({ name: 'lite-cli', kind: 'browser', run: async (page) => runLiteCliScenario((await readServerHarnessState()).urls.api, page) });
  }

  if (includePro) {
    scenarios.push({ name: 'pro-smoke', kind: 'browser', run: runProSmokeScenario });
    if (level === 'full') {
      scenarios.push({ name: 'pro-auth-restore', kind: 'browser', run: runProAuthRestoreScenario });
      scenarios.push({ name: 'pro-catalog', kind: 'browser', run: runProCatalogScenario });
      scenarios.push({ name: 'pro-accounting', kind: 'browser', run: runProAccountingScenario });
      scenarios.push({ name: 'pro-incoming-invoice-ui', kind: 'browser', run: runProIncomingInvoiceUiScenario });
      scenarios.push({ name: 'pro-incoming-document-archive', kind: 'browser', run: runProIncomingDocumentArchiveScenario });
      scenarios.push({ name: 'pro-outgoing-document-chain', kind: 'browser', run: runProOutgoingDocumentChainScenario });
      scenarios.push({ name: 'pro-route-guard', kind: 'browser', run: runProRouteGuardScenario });
      scenarios.push({ name: 'pro-worker-flows', kind: 'plain', run: () => runWorkerFlowScenario('pro') });
      scenarios.push({ name: 'pro-source-runs', kind: 'plain', run: runProSourceRunScenario });
    }
  }

  if (includeNonHappy && level === 'full') {
    scenarios.push({ name: 'pro-accounting-nonhappy', kind: 'plain', run: runProNonHappyAccountingScenario });
  }

  return scenarios;
};

const runBrowserScenario = async (browser, run, directory, exchanges) => {
  const context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) exchanges.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  });
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await page.screenshot({ path: path.join(directory, 'page.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(directory, 'page.html'), await page.content()).catch(() => {});
    await context.tracing.stop({ path: path.join(directory, 'trace.zip') });
    await context.close();
  }
};

const main = async () => {
  const scenarios = buildScenarioList().filter((scenario) => !process.env.SERVER_E2E_SCENARIO || scenario.name === process.env.SERVER_E2E_SCENARIO);
  if (scenarios.length === 0) {
    throw new Error(`No server-mode scenarios selected for scope "${scope}".`);
  }

  console.log(`Running server-mode ${level} suite (${scope}) with ${scenarios.length} scenario(s)...`);

  const reuse = process.env.SERVER_E2E_REUSE_STACK === '1';
  const keep = process.env.SERVER_E2E_KEEP_STACK === '1';
  const state = reuse ? await readServerHarnessState() : await startServerModeStack();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billme-server-e2e-'));
  const stableStateFile = path.join(stateDir, 'runtime-state.json');
  let browser = null;
  const resultsDir = path.resolve(process.env.SERVER_E2E_RESULTS_DIR || `test-results/server-mode/runs/${Date.now()}`);
  await fs.mkdir(resultsDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), level, scope, mode: state.mode, freshStack: !reuse, projectName: state.projectName, healthChecks: state.containerRuntime === 'podman' && state.mode === 'compose' ? 'declared checks scheduled by harness' : 'runtime', scenarios: [] };
  let exchanges = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = new URL(response.url);
    exchanges.push({ method: init?.method ?? 'GET', path: url.pathname, status: response.status });
    return response;
  };

  try {
    await fs.writeFile(stableStateFile, JSON.stringify({ ...state, stateFile: stableStateFile }, null, 2));
    process.env.E2E_SERVER_STATE_FILE = stableStateFile;
    if (scenarios.some((scenario) => scenario.kind === 'browser')) {
      browser = await chromium.launch({
        headless,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      });
    }

    for (const scenario of scenarios) {
      console.log(`→ ${scenario.name}`);
      const directory = path.join(resultsDir, scenario.name);
      await fs.mkdir(directory, { recursive: true });
      exchanges = [];
      const result = { name: scenario.name, status: 'failed', startedAt: new Date().toISOString() };
      process.env.E2E_SCREENSHOT_DIR = directory;
      try {
        if (scenario.kind === 'browser') await runBrowserScenario(browser, scenario.run, directory, exchanges);
        else await scenario.run();
        result.status = 'passed';
        console.log(`✓ ${scenario.name}`);
      } catch (error) {
        result.error = error.stack ?? String(error);
        throw error;
      } finally {
        result.finishedAt = new Date().toISOString();
        report.scenarios.push(result);
        await fs.writeFile(path.join(directory, 'requests.json'), JSON.stringify(exchanges, null, 2));
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    report.finishedAt = new Date().toISOString();
    report.selected = scenarios.length;
    report.passed = report.scenarios.filter((result) => result.status === 'passed').length;
    await fs.writeFile(path.join(resultsDir, 'summary.json'), JSON.stringify(report, null, 2));
    console.log(`Server-mode artifacts: ${resultsDir}`);
    await browser?.close().catch(() => {});
    if (!keep && !reuse) await stopServerModeStack(state).catch(() => {});
    if (!keep) await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    else console.log(`Retained isolated stack state: ${stableStateFile}`);
  }
};

await main();
