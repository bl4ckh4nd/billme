import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { readServerHarnessState } from './harness.mjs';
import { createLiteIdentity, getLiteRuntime, provisionLiteSession } from './lite/support.mjs';
import { createOwnerCredentials, ensureHarnessSession, seedHarnessProTenant } from './pro/helpers.mjs';

const { Pool } = pg;

const json = async (baseUrl, path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await response.json().catch(() => null);
  return { response, body };
};

export const runMobileApiScenario = async () => {
  const { state, databaseUrl } = await getLiteRuntime();
  const identity = createLiteIdentity('mobile-api');
  const { session, seed } = await provisionLiteSession({
    apiBaseUrl: state.urls.api,
    databaseUrl,
    ...identity,
  });
  const login = await json(state.urls.api, '/api/v1/lite/auth/device-sessions/login', {
    method: 'POST',
    body: { email: identity.email, password: identity.password, deviceName: 'E2E Android', platform: 'android' },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.product, 'lite');

  const pairing = await json(state.urls.api, '/api/v1/lite/auth/pairing-codes', {
    method: 'POST', token: session.token,
  });
  assert.equal(pairing.response.status, 200);
  assert.ok(new Date(pairing.body.expiresAt).getTime() > Date.now() + 4 * 60_000);
  const exchange = await json(state.urls.api, '/api/v1/lite/auth/pairing-codes/exchange', {
    method: 'POST', body: { code: pairing.body.code, deviceName: 'Paired iPhone', platform: 'ios' },
  });
  assert.equal(exchange.response.status, 200);
  const reused = await json(state.urls.api, '/api/v1/lite/auth/pairing-codes/exchange', {
    method: 'POST', body: { code: pairing.body.code, deviceName: 'Second device', platform: 'ios' },
  });
  assert.equal(reused.response.status, 401);

  const rotated = await json(state.urls.api, '/api/v1/lite/auth/device-sessions/refresh', {
    method: 'POST', body: { refreshToken: exchange.body.refreshToken },
  });
  assert.equal(rotated.response.status, 200);
  const oldRefresh = await json(state.urls.api, '/api/v1/lite/auth/device-sessions/refresh', {
    method: 'POST', body: { refreshToken: exchange.body.refreshToken },
  });
  assert.equal(oldRefresh.response.status, 401);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const receiptId = crypto.randomUUID();
  const upload = await json(state.urls.api, '/api/v1/lite/receipts', {
    method: 'POST', token: rotated.body.accessToken, body: {
      metadata: {
        id: receiptId,
        originalName: 'mobile-e2e.png',
        mimeType: 'image/png',
        sha256: crypto.createHash('sha256').update(png).digest('hex'),
      },
      dataBase64: png.toString('base64'),
    },
  });
  assert.equal(upload.response.status, 200);
  const content = await json(state.urls.api, `/api/v1/lite/receipts/${receiptId}/content?format=base64`, {
    token: rotated.body.accessToken,
  });
  assert.equal(content.response.status, 200);
  assert.deepEqual(Buffer.from(content.body.dataBase64, 'base64'), png);

  const sourceResponse = await json(state.urls.api, `/api/v1/lite/invoices/${seed.invoices[0].id}`, {
    token: rotated.body.accessToken,
  });
  assert.equal(sourceResponse.response.status, 200);
  const source = sourceResponse.body;
  const { tenantId: _tenantId, number: _number, createdAt: _createdAt, updatedAt: _updatedAt, ...baseDraft } = source;
  const mutationId = crypto.randomUUID();
  const draft = {
    ...baseDraft,
    kind: 'invoice',
    id: crypto.randomUUID(),
    status: 'open',
    payments: [],
    history: [],
  };
  const finalizeBody = {
    clientMutationId: mutationId,
    reason: 'Mobile E2E finalization',
    draft,
    delivery: {
      recipientEmail: source.clientEmail,
      recipientName: source.client,
      subject: 'Mobile E2E invoice',
      bodyText: 'Rendered and queued by the mobile delivery flow.',
    },
  };
  const finalized = await json(state.urls.api, '/api/v1/lite/documents/invoice/finalize', {
    method: 'POST', token: rotated.body.accessToken, body: finalizeBody,
  });
  assert.equal(finalized.response.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.replayed, false);
  const replayed = await json(state.urls.api, '/api/v1/lite/documents/invoice/finalize', {
    method: 'POST', token: rotated.body.accessToken, body: finalizeBody,
  });
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.body.replayed, true);
  assert.equal(replayed.body.document.id, finalized.body.document.id);
  let pdf = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await fetch(`${state.urls.api}/api/v1/lite/documents/invoice/${finalized.body.document.id}/pdf`, {
      headers: { authorization: `Bearer ${rotated.body.accessToken}` },
    });
    if (response.status === 200) {
      pdf = Buffer.from(await response.arrayBuffer());
      break;
    }
    assert.equal(response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(pdf?.subarray(0, 5).equals(Buffer.from('%PDF-')));

  const home = await json(state.urls.api, '/api/v1/lite/mobile/home', { token: rotated.body.accessToken });
  assert.equal(home.response.status, 200);
  assert.ok(home.body.recentActivity.some((entry) => entry.id === `receipt:${receiptId}`));

  const revoked = await json(state.urls.api, `/api/v1/lite/auth/device-sessions/${login.body.device.id}`, {
    method: 'DELETE', token: login.body.accessToken,
  });
  assert.equal(revoked.response.status, 200);
  const revokedRefresh = await json(state.urls.api, '/api/v1/lite/auth/device-sessions/refresh', {
    method: 'POST', body: { refreshToken: login.body.refreshToken },
  });
  assert.equal(revokedRefresh.response.status, 401);
};

export const runMobileProApiScenario = async () => {
  const state = await readServerHarnessState();
  const { databaseUrl } = await getLiteRuntime();
  const identity = createOwnerCredentials('pro');
  const session = await ensureHarnessSession(state, { product: 'pro', ...identity });
  await seedHarnessProTenant(state, { tenantId: session.tenantId, namespace: `mobile-pro-${Date.now()}` });
  const login = await json(state.urls.api, '/api/v1/pro/auth/device-sessions/login', {
    method: 'POST',
    body: { email: identity.email, password: identity.password, deviceName: 'Pro E2E Android', platform: 'android' },
  });
  assert.equal(login.response.status, 200);

  const pool = new Pool({ connectionString: databaseUrl });
  const receiptId = crypto.randomUUID();
  const now = new Date().toISOString();
  const suggestion = {
    merchant: { value: 'Mobile Pro Supplies', confidence: 1 },
    invoiceNumber: { value: 'PRO-MOBILE-1', confidence: 1 },
    date: { value: '2026-07-12', confidence: 1 },
    currency: { value: 'EUR', confidence: 1 },
    grossAmount: { value: 119, confidence: 1 },
    netAmount: { value: 100, confidence: 1 },
    vatAmount: { value: 19, confidence: 1 },
    suggestedAccountNumber: { value: '4930', confidence: 1 },
  };
  try {
    await pool.query(
      `INSERT INTO receipts (id, tenant_id, product, original_name, mime_type, byte_size, sha256, status, storage_key, suggestion_json, created_at, updated_at)
       VALUES ($1,$2,'pro','pro-mobile.png','image/png',1,$3,'needs_review',$4,$5,$6,$6)`,
      [receiptId, session.tenantId, crypto.createHash('sha256').update(receiptId).digest('hex'),
        `${session.tenantId}/receipts/${receiptId}.png`, JSON.stringify(suggestion), now],
    );
    const confirmed = await json(state.urls.api, `/api/v1/pro/receipts/${receiptId}/confirm`, {
      method: 'POST', token: login.body.accessToken,
      body: { reason: 'Pro mobile E2E review', suggestion },
    });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.status, 'confirmed');

    const queue = await json(state.urls.api, '/api/v1/pro/accounting/review-queue', { token: login.body.accessToken });
    assert.equal(queue.response.status, 200);
    const draft = queue.body.find((entry) => entry.transactionId === `receipt:${receiptId}`);
    assert.ok(draft);
    assert.equal(draft.workflowStatus, 'ready_for_review');
    assert.equal(draft.period, '2026-07');
    assert.equal(draft.fiscalYear, 2026);

    const approved = await json(state.urls.api, `/api/v1/pro/accounting/booking-drafts/${draft.id}/actions`, {
      method: 'POST', token: login.body.accessToken,
      body: { action: 'approve', reason: 'Pro mobile E2E approval' },
    });
    assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.workflowStatus, 'approved');
    await pool.query(
      `INSERT INTO accounting_periods (id, tenant_id, period, fiscal_year, status, starts_at, ends_at, created_at, updated_at)
       VALUES ($1,$2,'2026-07',2026,'closed','2026-07-01','2026-07-31',$3,$3)
       ON CONFLICT (tenant_id, period) DO UPDATE SET status = 'closed', updated_at = EXCLUDED.updated_at`,
      [crypto.randomUUID(), session.tenantId, new Date().toISOString()],
    );
    const blocked = await json(state.urls.api, `/api/v1/pro/accounting/booking-drafts/${draft.id}/actions`, {
      method: 'POST', token: login.body.accessToken,
      body: { action: 'post', reason: 'Pro mobile E2E locked-period check' },
    });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.message, 'Accounting period is locked');
    const blockedAudit = await pool.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_type = 'booking-draft' AND entity_id = $2
       ORDER BY sequence DESC LIMIT 1`,
      [session.tenantId, draft.id],
    );
    assert.equal(blockedAudit.rows[0]?.action, 'booking-draft.post-blocked');
    await pool.query(
      `UPDATE accounting_periods SET status = 'open', updated_at = $3 WHERE tenant_id = $1 AND period = $2`,
      [session.tenantId, '2026-07', new Date().toISOString()],
    );
    const posted = await json(state.urls.api, `/api/v1/pro/accounting/booking-drafts/${draft.id}/actions`, {
      method: 'POST', token: login.body.accessToken,
      body: { action: 'post', reason: 'Pro mobile E2E posting' },
    });
    assert.equal(posted.response.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.workflowStatus, 'posted');
    const persisted = await pool.query(
      'SELECT workflow_status FROM booking_drafts WHERE tenant_id = $1 AND id = $2',
      [session.tenantId, draft.id],
    );
    assert.equal(persisted.rows[0]?.workflow_status, 'posted');
  } finally {
    await pool.end();
  }
};
