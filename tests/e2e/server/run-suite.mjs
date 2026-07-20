import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { startServerModeStack, stopServerModeStack } from './harness.mjs';
import { runStackSmokeScenario } from './scenarios.mjs';
import {
  runLiteAuthScenario,
  runLiteRegressionScenario,
  runLiteSmokeScenario,
  runLiteWorkflowScenario,
} from './lite/scenarios.mjs';
import { runWorkerFlowScenario } from './worker-flows.mjs';
import { runMobileApiScenario, runMobileProApiScenario } from './mobile-scenarios.mjs';
import {
  runProAccountingScenario,
  runProAuthRestoreScenario,
  runProCatalogScenario,
  runProOfferPersistenceScenario,
  runProRouteGuardScenario,
  runProSmokeScenario,
} from './pro/scenarios.mjs';

const level = process.argv[2] === 'full' ? 'full' : 'smoke';
const scope = process.argv[3] ?? 'all';
const headless = !(process.env.SERVER_E2E_HEADED === '1' || process.env.PW_HEADLESS === '0');

process.env.E2E_TARGET = 'server';
if (level === 'full') {
  process.env.E2E_FULL = '1';
}

const buildScenarioList = () => {
  const scenarios = [];
  const includeStack = scope === 'all' || scope === 'stack' || scope === 'lite' || scope === 'pro';
  const includeLite = scope === 'all' || scope === 'lite';
  const includePro = scope === 'all' || scope === 'pro';
  const includeMobile = includeLite || scope === 'mobile';

  if (includeStack) {
    scenarios.push({ name: 'stack-smoke', kind: 'plain', run: runStackSmokeScenario });
  }

  if (includeMobile) {
    scenarios.push({ name: 'mobile-api', kind: 'plain', run: runMobileApiScenario });
    if (scope === 'mobile') scenarios.push({ name: 'mobile-pro-api', kind: 'plain', run: runMobileProApiScenario });
  }

  if (scope === 'mobile-pro') {
    scenarios.push({ name: 'mobile-pro-api', kind: 'plain', run: runMobileProApiScenario });
  }

  if (scope === 'mobile-lite') {
    scenarios.push({ name: 'mobile-api', kind: 'plain', run: runMobileApiScenario });
  }

  if (includeLite) {
    scenarios.push({ name: 'lite-smoke', kind: 'browser', run: runLiteSmokeScenario });
    if (level === 'full') {
      scenarios.push({ name: 'lite-auth', kind: 'browser', run: (page) => runLiteAuthScenario(page, 'runner-lite-auth') });
      scenarios.push({ name: 'lite-regressions', kind: 'browser', run: (page) => runLiteRegressionScenario(page, 'runner-lite-regressions') });
      scenarios.push({ name: 'lite-workflow', kind: 'browser', run: (page) => runLiteWorkflowScenario(page, 'runner-lite-workflow') });
      scenarios.push({ name: 'lite-worker-flows', kind: 'plain', run: () => runWorkerFlowScenario('lite') });
    }
  }

  if (includePro) {
    scenarios.push({ name: 'mobile-pro-api', kind: 'plain', run: runMobileProApiScenario });
    scenarios.push({ name: 'pro-smoke', kind: 'browser', run: runProSmokeScenario });
    scenarios.push({ name: 'pro-offer-persistence', kind: 'plain', run: runProOfferPersistenceScenario });
    if (level === 'full') {
      scenarios.push({ name: 'pro-auth-restore', kind: 'browser', run: runProAuthRestoreScenario });
      scenarios.push({ name: 'pro-catalog', kind: 'browser', run: runProCatalogScenario });
      scenarios.push({ name: 'pro-accounting', kind: 'browser', run: runProAccountingScenario });
      scenarios.push({ name: 'pro-route-guard', kind: 'browser', run: runProRouteGuardScenario });
      scenarios.push({ name: 'pro-worker-flows', kind: 'plain', run: () => runWorkerFlowScenario('pro') });
    }
  }

  return scenarios;
};

const runBrowserScenario = async (browser, run) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await run(page);
  } finally {
    await context.close();
  }
};

const main = async () => {
  const scenarios = buildScenarioList();
  if (scenarios.length === 0) {
    throw new Error(`No server-mode scenarios selected for scope "${scope}".`);
  }

  console.log(`Running server-mode ${level} suite (${scope}) with ${scenarios.length} scenario(s)...`);

  const state = await startServerModeStack();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billme-server-e2e-'));
  const stableStateFile = path.join(stateDir, 'runtime-state.json');
  let browser = null;

  try {
    await fs.writeFile(stableStateFile, JSON.stringify({ ...state, stateFile: stableStateFile }, null, 2));
    process.env.E2E_SERVER_STATE_FILE = stableStateFile;
    if (scenarios.some((scenario) => scenario.kind === 'browser')) {
      browser = await chromium.launch({ headless });
    }

    for (const scenario of scenarios) {
      console.log(`→ ${scenario.name}`);
      if (scenario.kind === 'browser') {
        await runBrowserScenario(browser, scenario.run);
      } else {
        await scenario.run();
      }
      console.log(`✓ ${scenario.name}`);
    }
  } finally {
    await browser?.close().catch(() => {});
    await stopServerModeStack(state).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
};

await main();
