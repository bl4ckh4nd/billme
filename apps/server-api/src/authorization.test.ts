import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTenantCapability, tenantCapabilities } from './authorization.js';

test('owner and admin can perform every tenant capability', () => {
  for (const role of ['owner', 'admin'] as const) {
    for (const capability of tenantCapabilities) {
      assert.doesNotThrow(() => assertTenantCapability(role, capability));
    }
  }
});

test('delegated roles remain within their approved domains', () => {
  assert.doesNotThrow(() => assertTenantCapability('accountant', 'documents:invoice:write'));
  assert.doesNotThrow(() => assertTenantCapability('accountant', 'accounting:write'));
  assert.throws(() => assertTenantCapability('accountant', 'delete'));
  assert.doesNotThrow(() => assertTenantCapability('sales', 'clients:write'));
  assert.throws(() => assertTenantCapability('sales', 'documents:invoice:write'));
  assert.throws(() => assertTenantCapability('viewer', 'documents:offer:write'));
});
