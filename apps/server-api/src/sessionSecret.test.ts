import assert from 'node:assert/strict';
import test from 'node:test';
import { DEV_SESSION_SECRET, checkSessionSecret } from './auth.js';

const STRONG = 'a'.repeat(32);

test('local development tolerates a missing secret but warns', () => {
  const verdict = checkSessionSecret({});
  assert.equal(verdict.ok, true);
  assert.ok(verdict.ok && verdict.warning, 'expected a warning');
});

test('a deployment with DATABASE_URL refuses to start without a secret', () => {
  const verdict = checkSessionSecret({ DATABASE_URL: 'postgresql://x/y' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? '' : verdict.error, /SESSION_SECRET is not set/);
});

test('the built-in development secret is rejected in a deployment', () => {
  const verdict = checkSessionSecret({ DATABASE_URL: 'postgresql://x/y', SESSION_SECRET: DEV_SESSION_SECRET });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? '' : verdict.error, /built-in development value/);
});

test('a short secret is rejected in a deployment', () => {
  const verdict = checkSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: 'too-short' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? '' : verdict.error, /shorter than 32/);
});

test('a strong secret passes in a deployment', () => {
  assert.deepEqual(checkSessionSecret({ DATABASE_URL: 'postgresql://x/y', SESSION_SECRET: STRONG }), { ok: true });
  assert.deepEqual(checkSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: STRONG }), { ok: true });
});

test('whitespace does not count towards the length', () => {
  const verdict = checkSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: `  ${'b'.repeat(10)}  ` });
  assert.equal(verdict.ok, false);
});
