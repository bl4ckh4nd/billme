import assert from 'node:assert/strict';
import test from 'node:test';
import { serverApiContract } from './contract.js';

test('server API contract keeps explicit Lite/Pro OpenAPI boundaries', () => {
  assert.equal(serverApiContract.lite.auth.login['~orpc'].route.path, '/api/v1/lite/auth/login');
  assert.equal(serverApiContract.pro.auth.login['~orpc'].route.path, '/api/v1/pro/auth/login');
  assert.equal(serverApiContract.lite.tax.validateVatId['~orpc'].route.path, '/api/v1/lite/tax/validate-vat-id');
  assert.equal(serverApiContract.pro.tax.validateVatId['~orpc'].route.path, '/api/v1/pro/tax/validate-vat-id');
  assert.equal(serverApiContract.meta.capabilities['~orpc'].route.path, '/api/v1/meta/capabilities');
});
