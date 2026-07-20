import assert from 'node:assert/strict';
import test from 'node:test';
import { isPortalUrlAllowed, parsePortalAllowedOrigins } from './portal-url-policy.js';

test('portal URL policy only permits configured HTTPS origins', () => {
  const allowed = parsePortalAllowedOrigins('https://portal.example, https://offers.example');

  assert.equal(isPortalUrlAllowed('https://portal.example/api', allowed), true);
  assert.equal(isPortalUrlAllowed('https://internal.example', allowed), false);
  assert.equal(isPortalUrlAllowed('http://portal.example', allowed), false);
});

test('portal URL policy rejects malformed allowlist entries', () => {
  assert.throws(() => parsePortalAllowedOrigins('http://portal.example'));
});
