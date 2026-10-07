import { expect } from '@playwright/test';
import { getComposeServiceHealth, readServerHarnessState } from './harness.mjs';

export const runStackSmokeScenario = async () => {
  const state = await readServerHarnessState();

  const [apiHealthResponse, liteBootstrapResponse, proBootstrapResponse, workerHealth] = await Promise.all([
    fetch(state.urls.apiHealth),
    fetch(state.urls.liteBootstrapStatus, { headers: { accept: 'application/json' } }),
    fetch(state.urls.proBootstrapStatus, { headers: { accept: 'application/json' } }),
    getComposeServiceHealth('server-worker', state),
  ]);

  expect(apiHealthResponse.ok).toBe(true);
  await expect(apiHealthResponse.json()).resolves.toMatchObject({
    ok: true,
    service: 'billme-server-api',
    mode: 'api',
  });

  await expect(liteBootstrapResponse.json()).resolves.toEqual({
    bootstrapped: false,
    userCount: 0,
    // The stack runs with BILLME_SETUP_TOKEN, so a fresh instance cannot be claimed without it.
    setupTokenRequired: true,
  });
  await expect(proBootstrapResponse.json()).resolves.toEqual({
    bootstrapped: false,
    userCount: 0,
    // The stack runs with BILLME_SETUP_TOKEN, so a fresh instance cannot be claimed without it.
    setupTokenRequired: true,
  });

  expect(workerHealth).toBe('healthy');
};
