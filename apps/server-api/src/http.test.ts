import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerErrorHandler } from './http.js';

test('accounting domain errors map to stable HTTP status codes', async () => {
  const app = Fastify();
  registerErrorHandler(app);
  app.get('/conflict', async () => { throw new Error('POSTING_DATE_IN_CLOSED_PERIOD'); });
  app.get('/source-run-conflict', async () => { throw new Error('ACCOUNTING_SOURCE_RUN_CONFLICT'); });
  app.get('/chart-locked', async () => { throw new Error('ACCOUNTING_CHART_LOCKED'); });
  app.get('/document-not-postable', async () => { throw new Error('DOCUMENT_NOT_POSTABLE'); });
  app.get('/unprocessable', async () => { throw new Error('PAYMENT_SOURCE_MISMATCH'); });
  app.get('/invalid', async () => { throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED'); });
  try {
    assert.equal((await app.inject('/conflict')).statusCode, 409);
    assert.equal((await app.inject('/source-run-conflict')).statusCode, 409);
    assert.equal((await app.inject('/chart-locked')).statusCode, 409);
    assert.equal((await app.inject('/document-not-postable')).statusCode, 409);
    assert.equal((await app.inject('/unprocessable')).statusCode, 422);
    assert.equal((await app.inject('/invalid')).statusCode, 400);
  } finally {
    await app.close();
  }
});
