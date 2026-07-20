import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAgentInvocationAllowed,
  getAgentActionCatalog,
  isAgentAction,
  parseAgentArgs,
} from './index.js';
import { ipcRoutes as liteRoutes } from '@billme/desktop-contracts/contract';
import { ipcRoutes as proRoutes } from '@billme/desktop-contracts-pro/contract';

test('catalog keeps business actions and excludes OS-only controls', () => {
  const catalog = getAgentActionCatalog('pro');
  const actions = new Set(catalog.map((entry) => entry.action));

  assert.equal(actions.has('invoices:list'), true);
  assert.equal(actions.has('pro:postDraft'), true);
  assert.equal(actions.has('window:close'), false);
  assert.equal(actions.has('secrets:get'), false);
});

test('every contract route is classified or explicitly excluded', () => {
  for (const [product, routes] of [['lite', liteRoutes], ['pro', proRoutes]] as const) {
    const catalog = new Set(getAgentActionCatalog(product).map((entry) => entry.action));
    for (const action of Object.keys(routes)) {
      assert.equal(catalog.has(action), isAgentAction(product, action), `${product}:${action}`);
    }
  }
});

test('mutations require a reason and destructive actions require confirmation', () => {
  assert.throws(
    () => assertAgentInvocationAllowed('lite', 'clients:upsert', { confirm: false }),
    /requires --reason/,
  );
  assert.throws(
    () => assertAgentInvocationAllowed('lite', 'clients:delete', { reason: 'cleanup', confirm: false }),
    /requires --confirm/,
  );
  assert.doesNotThrow(() =>
    assertAgentInvocationAllowed('lite', 'clients:delete', { reason: 'cleanup', confirm: true }),
  );
});

test('action input is validated by the existing IPC schema', () => {
  assert.deepEqual(parseAgentArgs('lite', 'clients:list', undefined), undefined);
  assert.throws(() => parseAgentArgs('lite', 'clients:delete', { id: '' }), /too_small/);
});
