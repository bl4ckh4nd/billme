import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServerHarnessState } from '../harness.mjs';
import {
  createOwnerCredentials,
  ensureHarnessSession,
  requestJson,
  requestText,
  seedHarnessProTenant,
} from './helpers.mjs';
import { createLiteIdentity, getLiteRuntime, provisionLiteSession } from '../lite/support.mjs';

const owner = createOwnerCredentials('pro');

const startPortalSink = async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: true, ts: '2026-08-24T10:00:00.000Z' }));
      return;
    }
    if (request.url?.includes('/status')) {
      response.end(JSON.stringify({ decision: {
        decidedAt: '2026-08-24T10:00:00.000Z',
        decision: 'accepted',
        acceptedName: 'Portal E2E Customer',
        acceptedEmail: 'portal-e2e@example.test',
        decisionTextVersion: 'v1',
      } }));
      return;
    }
    if (request.url?.startsWith('/customers/access-links')) {
      response.end(JSON.stringify({ ok: true, token: `customer-link-token-${requests.length}`, publicUrl: 'http://portal.test/link', expiresAt: '2026-09-24T10:00:00.000Z' }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Portal sink did not expose a TCP port.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

export const runLiveRouteMatrixScenario = async () => {
  const state = await readServerHarnessState();
  const session = await ensureHarnessSession(state, { product: 'pro', ...owner });
  const namespace = `live-route-matrix-${Date.now()}`;
  await seedHarnessProTenant(state, {
    tenantId: session.tenantId,
    namespace,
    includeEurCashFixtures: true,
    includeEurCatalog2026: true,
  });

  const verification = await requestJson(state, session, '/api/v1/pro/audit/verify');
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.errors, []);

  const exported = await requestText(state, session, '/api/v1/pro/audit/export.csv');
  assert.match(exported.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(exported.body, /sequence|occurred_at|action/i);

  const fixtureDir = await mkdtemp(join(tmpdir(), 'billme-live-route-matrix-'));
  try {
    const csvPath = join(fixtureDir, 'transactions.csv');
    await writeFile(csvPath, [
      'date,amount,counterparty,purpose,externalId,currency',
      '2026-04-01,42,Import Customer,Imported income,live-import-1,EUR',
      '2026-04-02,-17,Import Vendor,Imported expense,live-import-2,EUR',
    ].join('\n'));
    const mapping = {
      dateColumn: 'date',
      amountColumn: 'amount',
      counterpartyColumn: 'counterparty',
      purposeColumn: 'purpose',
      externalIdColumn: 'externalId',
      currencyColumn: 'currency',
    };
    const preview = await requestJson(state, session, '/api/v1/pro/finance/import/preview', undefined, {
      method: 'POST',
      body: { path: csvPath, profile: 'generic', mapping },
    });
    assert.equal(preview.stats.totalRows, 2);
    assert.equal(preview.stats.validRows, 2);
    assert.equal(preview.rows[0].parsed.counterparty, 'Import Customer');

    const accountId = `${namespace}-account-primary`;
    const committed = await requestJson(state, session, '/api/v1/pro/finance/import/commit', undefined, {
      method: 'POST',
      body: { path: csvPath, accountId, profile: 'generic', mapping },
    });
    assert.equal(committed.imported, 2);
    assert.equal(committed.errors.length, 0);

    const batches = await requestJson(state, session, '/api/v1/pro/finance/import-batches', { accountId, limit: 10 });
    const batch = batches.find((entry) => entry.id === committed.batchId);
    assert.equal(batch?.importedCount, 2);
    const details = await requestJson(state, session, `/api/v1/pro/finance/import-batches/${committed.batchId}`);
    assert.equal(details.transactions.length, 2);
    assert.equal(details.canRollback, true);
    const importedTransaction = details.transactions[0];
    assert.ok(importedTransaction?.id);

    const invoiceId = `${namespace}-invoice-open`;
    await requestJson(state, session, `/api/v1/pro/transactions/${importedTransaction.id}/link`, undefined, {
      method: 'POST',
      body: { invoiceId, reason: 'Live route matrix link' },
    });
    const linked = await requestJson(state, session, '/api/v1/pro/transactions', { accountId, linkedOnly: true });
    assert.equal(linked.some((transaction) => transaction.id === importedTransaction.id && transaction.linkedInvoiceId === invoiceId), true);
    await requestJson(state, session, `/api/v1/pro/transactions/${importedTransaction.id}/unlink`, undefined, {
      method: 'POST',
      body: { reason: 'Live route matrix unlink' },
    });
    const unlinked = await requestJson(state, session, '/api/v1/pro/transactions', { accountId, unlinkedOnly: true });
    assert.equal(unlinked.some((transaction) => transaction.id === importedTransaction.id), true);

    const rolledBack = await requestJson(state, session, `/api/v1/pro/finance/import-batches/${committed.batchId}/rollback`, undefined, {
      method: 'POST',
      body: { reason: 'Live route matrix rollback' },
    });
    assert.equal(rolledBack.deletedCount, 2);
    const afterRollback = await requestJson(state, session, `/api/v1/pro/finance/import-batches/${committed.batchId}`);
    assert.equal(afterRollback.canRollback, false);
    assert.equal(afterRollback.transactions.length, 0);

    const currentSettings = await requestJson(state, session, '/api/v1/pro/settings');
    await requestJson(state, session, '/api/v1/pro/settings', undefined, {
      method: 'PUT',
      body: {
        settings: {
          ...currentSettings,
          businessReportingProfile: {
            jurisdiction: 'DE',
            legalForm: 'sole_proprietor',
            profitDetermination: 'eur',
            fiscalYearStart: '01-01',
            vatMethod: 'soll',
          },
        },
      },
    });
    const eurItems = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/items', { taxYear: 2026 });
    assert.ok(eurItems.length >= 2);
    const incomeItem = eurItems.find((item) => item.flowType === 'income');
    const expenseItem = eurItems.find((item) => item.flowType === 'expense');
    assert.ok(incomeItem?.sourceId);
    assert.ok(expenseItem?.sourceId);

    const rule = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/rules', undefined, {
      method: 'POST',
      body: {
        taxYear: 2026,
        priority: 10,
        field: 'counterparty',
        operator: 'contains',
        value: 'E2E route matrix',
        targetEurLineId: 'E2026_KZ112',
        active: true,
        reason: 'Live route matrix EÜR rule',
      },
    });
    const rules = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/rules', { taxYear: 2026 });
    assert.ok(rules.some((entry) => entry.id === rule.id && entry.targetEurLineId === 'E2026_KZ112'));

    const filteredItems = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/items', {
      taxYear: 2026,
      sourceType: 'transaction',
      flowType: 'income',
      search: incomeItem.counterparty,
      status: 'unclassified',
      limit: 1,
      offset: 0,
    });
    assert.equal(filteredItems.length, 1);
    assert.equal(filteredItems[0].sourceId, incomeItem.sourceId);

    const classification = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/classifications', undefined, {
      method: 'PUT',
      body: {
        sourceType: incomeItem.sourceType,
        sourceId: incomeItem.sourceId,
        taxYear: 2026,
        eurLineId: 'E2026_KZ112',
        reason: 'Live route matrix classify income',
      },
    });
    assert.equal(classification.eurLineId, 'E2026_KZ112');
    const classified = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/items', {
      taxYear: 2026,
      status: 'classified',
      search: incomeItem.counterparty,
      limit: 1,
    });
    assert.equal(classified[0].sourceId, incomeItem.sourceId);
    const pagedUnclassified = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/items', {
      taxYear: 2026,
      onlyUnclassified: true,
      limit: 1,
      offset: 0,
    });
    assert.ok(pagedUnclassified.length <= 1);

    const expenseFact = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/facts/cash', undefined, {
      method: 'POST',
      body: {
        sourceType: expenseItem.sourceType,
        sourceId: expenseItem.sourceId,
        taxYear: 2026,
        kind: 'expense',
        flowType: 'expense',
        amountNet: expenseItem.amountNet,
        eurLineId: 'E2026_KZ280',
        splits: [{ amountNet: expenseItem.amountNet, deductibility: 'deductible', lineId: 'E2026_KZ280', reason: 'Live route matrix expense' }],
        idempotencyKey: `${namespace}-eur-expense-fact`,
        reason: 'Live route matrix EÜR cash fact',
      },
    });
    assert.equal(expenseFact.provenance.catalogId, 'anlage-euer-2026');
    assert.equal(expenseFact.splits.length, 1);
    const facts = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/facts/cash', { taxYear: 2026 });
    assert.ok(facts.some((fact) => fact.id === expenseFact.id));
    const annexFact = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/facts/annex', undefined, {
      method: 'POST',
      body: {
        taxYear: 2026,
        annex: 'AVEÜR',
        lineId: 'AVEÜR_2026_GB_100',
        amount: 250,
        sourceId: expenseItem.sourceId,
        date: '2026-03-05',
        idempotencyKey: `${namespace}-eur-annex-fact`,
        reason: 'Live route matrix AVEÜR fact',
      },
    });
    const annexFacts = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/facts/annex', { taxYear: 2026, annex: 'AVEÜR' });
    assert.ok(annexFacts.some((fact) => fact.id === annexFact.id && fact.lineId === 'AVEÜR_2026_GB_100'));
    const eurReport = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur', { taxYear: 2026 });
    assert.equal(eurReport.taxYear, 2026);
    assert.equal(eurReport.from, '2026-01-01');
    const eurCsv = await requestText(state, session, '/api/v1/pro/accounting/reports/eur/export.csv', { taxYear: 2026 });
    assert.match(eurCsv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(eurCsv.body, /Kennziffer;Bezeichnung;Betrag/);

    await requestJson(state, session, `/api/v1/pro/accounting/reports/eur/rules/${encodeURIComponent(rule.id)}`, undefined, {
      method: 'DELETE',
      body: { reason: 'Live route matrix remove EÜR rule' },
    });
    const rulesAfterDelete = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/rules', { taxYear: 2026 });
    assert.equal(rulesAfterDelete.some((entry) => entry.id === rule.id), false);

    const auditPackage = await requestJson(state, session, '/api/v1/pro/tax/audit-export-package', undefined, {
      method: 'POST',
      body: { from: '2026-01-01', to: '2026-12-31', includeDocuments: false },
    });
    assert.equal(auditPackage.includeDocuments, false);
    assert.ok(auditPackage.files.some((file) => file.name === 'audit-log.csv'));
    const auditPackageWithDocuments = await requestJson(state, session, '/api/v1/pro/tax/audit-export-package', undefined, {
      method: 'POST',
      body: { includeDocuments: true },
    });
    assert.equal(auditPackageWithDocuments.includeDocuments, true);
    const exportedInvoices = auditPackageWithDocuments.files.find((file) => file.name === 'invoices.jsonl');
    assert.ok(exportedInvoices?.content.includes(`${namespace}-invoice-open`));

    const projectId = `${namespace}-project-live`;
    const createdProject = await requestJson(state, session, '/api/v1/pro/projects', undefined, {
      method: 'POST',
      body: {
        reason: 'Live route matrix project create',
        project: {
          id: projectId,
          clientId: `${namespace}-client-beta`,
          name: 'Live route project',
          status: 'active',
          budget: 880,
          startDate: '2026-04-01',
          description: 'Created through the hosted route matrix',
        },
      },
    });
    assert.equal(createdProject.id, projectId);
    const betaProjects = await requestJson(state, session, '/api/v1/pro/projects', { clientId: `${namespace}-client-beta` });
    assert.ok(betaProjects.some((project) => project.id === projectId));
    const movedProject = await requestJson(state, session, '/api/v1/pro/projects', undefined, {
      method: 'POST',
      body: {
        reason: 'Live route matrix project move',
        project: { ...createdProject, clientId: `${namespace}-client-alpha` },
      },
    });
    assert.equal(movedProject.clientId, `${namespace}-client-alpha`);
    const movedProjects = await requestJson(state, session, '/api/v1/pro/projects', { clientId: `${namespace}-client-alpha` });
    assert.ok(movedProjects.some((project) => project.id === projectId));
    assert.equal((await requestJson(state, session, `/api/v1/pro/projects/${projectId}`)).clientId, `${namespace}-client-alpha`);
    assert.equal(await requestJson(state, session, `/api/v1/pro/projects/${namespace}-missing`), null);
    await requestJson(state, session, `/api/v1/pro/projects/${projectId}/archive`, undefined, {
      method: 'POST',
      body: { reason: 'Live route matrix project archive' },
    });
    const activeProjects = await requestJson(state, session, '/api/v1/pro/projects', { clientId: `${namespace}-client-alpha` });
    assert.equal(activeProjects.some((project) => project.id === projectId), false);
    const archivedProjects = await requestJson(state, session, '/api/v1/pro/projects', { clientId: `${namespace}-client-alpha`, includeArchived: true });
    assert.ok(archivedProjects.find((project) => project.id === projectId)?.archivedAt);

    const portal = await startPortalSink();
    try {
      const portalSettings = await requestJson(state, session, '/api/v1/pro/settings');
      await requestJson(state, session, '/api/v1/pro/settings', undefined, {
        method: 'PUT',
        body: { settings: { ...portalSettings, portal: { ...portalSettings.portal, baseUrl: portal.baseUrl } } },
      });
      const portalHealth = await requestJson(state, session, '/api/v1/pro/portal/health', { baseUrl: portal.baseUrl });
      assert.equal(portalHealth.ok, true);
      const publication = await requestJson(state, session, '/api/v1/pro/portal/publish-offer', undefined, {
        method: 'POST',
        body: { offerId: `${namespace}-offer-open` },
      });
      assert.ok(publication.token);
      const invoicePublication = await requestJson(state, session, '/api/v1/pro/portal/publish-invoice', undefined, {
        method: 'POST',
        body: { invoiceId: `${namespace}-invoice-open` },
      });
      assert.ok(invoicePublication.publicUrl);
      const synced = await requestJson(state, session, '/api/v1/pro/portal/sync-offer-status', undefined, {
        method: 'POST',
        body: { offerId: `${namespace}-offer-open` },
      });
      assert.equal(synced.updated, true);
      const accessLink = await requestJson(state, session, '/api/v1/pro/portal/customer-access-link', undefined, {
        method: 'POST',
        body: { customerRef: `${namespace}-client-alpha`, customerLabel: 'Portal Customer' },
      });
      const rotatedLink = await requestJson(state, session, '/api/v1/pro/portal/customer-access-link/rotate', undefined, {
        method: 'POST',
        body: { customerRef: `${namespace}-client-alpha`, customerLabel: 'Portal Customer' },
      });
      assert.notEqual(accessLink.token, rotatedLink.token);

      const queued = await requestJson(state, session, '/api/v1/pro/email/send', undefined, {
        method: 'POST',
        body: {
          documentType: 'invoice',
          documentId: `${namespace}-invoice-open`,
          recipientEmail: 'portal-e2e@example.test',
          recipientName: 'Portal E2E Customer',
          subject: 'Live route matrix email',
          bodyText: 'Queued by the server route matrix',
        },
      });
      assert.equal(queued.success, true);
      const emailConfig = await requestJson(state, session, '/api/v1/pro/email/test-config', undefined, {
        method: 'POST', body: { provider: 'resend' },
      });
      assert.equal(emailConfig.success, false);
      assert.match(emailConfig.error, /server|configured/i);
      const dunningStatus = await requestJson(state, session, `/api/v1/pro/dunning/invoices/${namespace}-invoice-open/status`);
      assert.equal(dunningStatus.currentLevel, 0);
      const dunningRun = await requestJson(state, session, '/api/v1/pro/dunning/manual-run', undefined, { method: 'POST' });
      assert.equal(typeof dunningRun.success, 'boolean');
      const recurringRun = await requestJson(state, session, '/api/v1/pro/recurring/manual-run', undefined, { method: 'POST' });
      assert.equal(typeof recurringRun.success, 'boolean');
      if (recurringRun.success) assert.ok(recurringRun.result.generated >= 1);
      assert.ok(portal.requests.some((request) => request.path === '/health'));
      assert.ok(portal.requests.some((request) => request.path === '/offers'));
      assert.ok(portal.requests.some((request) => request.path === '/invoices'));
      assert.ok(portal.requests.some((request) => request.path?.includes('/status')));
    } finally {
      await portal.close();
    }
    const finalVerification = await requestJson(state, session, '/api/v1/pro/audit/verify');
    assert.equal(finalVerification.ok, true, JSON.stringify(finalVerification));
    assert.ok(finalVerification.count > 0);
    const finalAuditCsv = await requestText(state, session, '/api/v1/pro/audit/export.csv');
    assert.match(finalAuditCsv.body, /project|email|portal|eur/i);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
};

export const runLiveLiteRouteMatrixScenario = async () => {
  const runtime = await getLiteRuntime();
  const identity = createLiteIdentity(`live-route-matrix-${Date.now()}`);
  const { session, seed } = await provisionLiteSession({
    apiBaseUrl: runtime.state.urls.api,
    databaseUrl: runtime.databaseUrl,
    ...identity,
  });
  assert.ok(seed?.clients[0]?.id);
  const namespace = identity.namespace;
  const portal = await startPortalSink();
  try {
    const verification = await requestJson(runtime.state, session, '/api/v1/lite/audit/verify');
    assert.equal(verification.ok, true);
    const exported = await requestText(runtime.state, session, '/api/v1/lite/audit/export.csv');
    assert.match(exported.body, /sequence|occurred_at|action/i);

    const projectId = `${namespace}-project-live`;
    const clientId = seed.clients[0].id;
    const createdProject = await requestJson(runtime.state, session, '/api/v1/lite/projects', undefined, {
      method: 'POST',
      body: {
        reason: 'Lite live route matrix project create',
        project: { id: projectId, clientId, name: 'Lite live project', status: 'active', budget: 420, startDate: '2026-04-01' },
      },
    });
    assert.equal(createdProject.id, projectId);
    assert.ok((await requestJson(runtime.state, session, '/api/v1/lite/projects', { clientId })).some((project) => project.id === projectId));
    await requestJson(runtime.state, session, `/api/v1/lite/projects/${projectId}/archive`, undefined, {
      method: 'POST',
      body: { reason: 'Lite live route matrix project archive' },
    });
    assert.equal((await requestJson(runtime.state, session, '/api/v1/lite/projects', { clientId })).some((project) => project.id === projectId), false);
    assert.ok((await requestJson(runtime.state, session, '/api/v1/lite/projects', { clientId, includeArchived: true })).find((project) => project.id === projectId)?.archivedAt);

    const currentSettings = await requestJson(runtime.state, session, '/api/v1/lite/settings');
    await requestJson(runtime.state, session, '/api/v1/lite/settings', undefined, {
      method: 'PUT',
      body: { settings: { ...currentSettings, portal: { ...currentSettings.portal, baseUrl: portal.baseUrl } } },
    });
    assert.equal((await requestJson(runtime.state, session, '/api/v1/lite/portal/health', { baseUrl: portal.baseUrl })).ok, true);
    const offerId = seed.offers[0].id;
    const invoiceId = seed.invoices[0].id;
    assert.ok((await requestJson(runtime.state, session, '/api/v1/lite/portal/publish-offer', undefined, {
      method: 'POST', body: { offerId },
    })).token);
    assert.ok((await requestJson(runtime.state, session, '/api/v1/lite/portal/publish-invoice', undefined, {
      method: 'POST', body: { invoiceId },
    })).token);
    const synced = await requestJson(runtime.state, session, '/api/v1/lite/portal/sync-offer-status', undefined, {
      method: 'POST', body: { offerId },
    });
    assert.equal(synced.updated, true);
    const accessLink = await requestJson(runtime.state, session, '/api/v1/lite/portal/customer-access-link', undefined, {
      method: 'POST', body: { customerRef: clientId },
    });
    const rotated = await requestJson(runtime.state, session, '/api/v1/lite/portal/customer-access-link/rotate', undefined, {
      method: 'POST', body: { customerRef: clientId },
    });
    assert.notEqual(accessLink.token, rotated.token);

    const queued = await requestJson(runtime.state, session, '/api/v1/lite/email/send', undefined, {
      method: 'POST',
      body: {
        documentType: 'invoice', documentId: invoiceId, recipientEmail: 'billing@acme.test',
        recipientName: seed.invoices[0].client, subject: 'Lite live route matrix email', bodyText: 'Queued by Lite server route',
      },
    });
    assert.equal(queued.success, true);
    const dunningStatus = await requestJson(runtime.state, session, `/api/v1/lite/dunning/invoices/${invoiceId}/status`);
    assert.equal(dunningStatus.currentLevel, 0);
    const dunningRun = await requestJson(runtime.state, session, '/api/v1/lite/dunning/manual-run', undefined, { method: 'POST' });
    assert.equal(typeof dunningRun.success, 'boolean');
    const recurringRun = await requestJson(runtime.state, session, '/api/v1/lite/recurring/manual-run', undefined, { method: 'POST' });
    assert.equal(typeof recurringRun.success, 'boolean');
    assert.ok(portal.requests.some((request) => request.path === '/offers'));
    assert.ok(portal.requests.some((request) => request.path === '/invoices'));
    assert.ok(portal.requests.some((request) => request.path?.includes('/status')));
    const persistedSettings = await requestJson(runtime.state, session, '/api/v1/lite/settings');
    assert.equal(persistedSettings.portal.baseUrl, portal.baseUrl);
    const finalVerification = await requestJson(runtime.state, session, '/api/v1/lite/audit/verify');
    assert.equal(finalVerification.ok, true);
    assert.ok(finalVerification.count > 0);
    const finalAuditCsv = await requestText(runtime.state, session, '/api/v1/lite/audit/export.csv');
    assert.match(finalAuditCsv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(finalAuditCsv.headers.get('content-disposition') ?? '', /audit\.csv/);
    assert.match(finalAuditCsv.body, /project|email|portal/i);
  } finally {
    await portal.close();
  }
};
