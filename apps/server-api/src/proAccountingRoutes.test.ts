import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerApi } from './app.js';
import {
  csvEscape,
  datevExportQuerySchema,
  eurReportQuerySchema,
  eurClassificationBodySchema,
  mappingOverrideBodySchema,
  mappingHealthQuerySchema,
  mappingPositionsQuerySchema,
  reportSnapshotBodySchema,
  reportSnapshotQuerySchema,
  susaReportQuerySchema,
  correctionSettlementBodySchema,
  closingCommandBodySchema,
  taxExportPreparationBodySchema,
} from './proAccountingRoutes.js';

test('DATEV CSV escaping protects semicolons, quotes, and line breaks', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('konto;gegenkonto'), '"konto;gegenkonto"');
  assert.equal(csvEscape('say "hello"'), '"say ""hello"""');
  assert.equal(csvEscape('line 1\nline 2'), '"line 1\nline 2"');
});

test('DATEV export query validates the full EXTF parameter set at the API boundary', () => {
  assert.throws(() => datevExportQuerySchema.parse({ from: '2026-03-01', to: '2026-03-31' }));
  const query = datevExportQuerySchema.parse({
    from: '2026-03-01',
    to: '2026-03-31',
    consultantNumber: '1001',
    clientNumber: '7',
    fiscalYearStart: '2026-01-01',
    accountLength: '5',
    encoding: 'utf8-bom',
  });
  assert.deepEqual(query, {
    from: '2026-03-01',
    to: '2026-03-31',
    reason: 'DATEV-Buchungsstapel exportiert',
    consultantNumber: '1001',
    clientNumber: '7',
    fiscalYearStart: '2026-01-01',
    accountLength: 5,
    encoding: 'utf8-bom',
  });
});

test('SuSa route accepts inclusive range bounds alongside legacy asOfDate', () => {
  assert.deepEqual(susaReportQuerySchema.parse({ from: '2026-12-01', to: '2026-12-31' }), {
    from: '2026-12-01',
    to: '2026-12-31',
  });
  assert.equal(susaReportQuerySchema.parse({ asOfDate: '2026-12-31' }).asOfDate, '2026-12-31');
});

test('report snapshots require a typed report and mutation reason', () => {
  assert.throws(() => reportSnapshotBodySchema.parse({ reportType: 'bwa01' }));
  assert.deepEqual(reportSnapshotBodySchema.parse({ reportType: 'bwa01', from: '2026-12-01', to: '2026-12-31', reason: 'Monatsabschluss' }), {
    reportType: 'bwa01',
    from: '2026-12-01',
    to: '2026-12-31',
    reason: 'Monatsabschluss',
  });
  assert.equal(reportSnapshotQuerySchema.parse({ reportType: 'guv' }).reportType, 'guv');
});

test('report snapshots accept distinct canonical report profiles', () => {
  assert.equal(reportSnapshotQuerySchema.parse({ reportType: 'management-guv' }).reportType, 'management-guv');
  assert.equal(reportSnapshotBodySchema.parse({ reportType: 'hgb-bilanz', asOfDate: '2026-12-31', reason: 'Jahresabschluss' }).reportType, 'hgb-bilanz');
});

test('EÜR uses its native report endpoint and calendar-year snapshot type', () => {
  assert.deepEqual(eurReportQuerySchema.parse({}), { from: '2025-01-01', to: '2025-12-31' });
  assert.throws(() => eurReportQuerySchema.parse({ from: '2026-01-01' }));
  assert.equal(reportSnapshotQuerySchema.parse({ reportType: 'eur' }).reportType, 'eur');
  assert.deepEqual(reportSnapshotBodySchema.parse({ reportType: 'eur', from: '2025-01-01', to: '2025-12-31', reason: 'EÜR 2025' }), {
    reportType: 'eur',
    from: '2025-01-01',
    to: '2025-12-31',
    reason: 'EÜR 2025',
  });
});

test('EÜR classifications require a mutation reason and normalize safe defaults', () => {
  assert.throws(() => eurClassificationBodySchema.parse({ sourceType: 'transaction', sourceId: 'bank-1', taxYear: 2025 }));
  assert.deepEqual(eurClassificationBodySchema.parse({ sourceType: 'transaction', sourceId: 'bank-1', taxYear: 2025, reason: 'Beleg geprüft' }), {
    sourceType: 'transaction',
    sourceId: 'bank-1',
    taxYear: 2025,
    excluded: false,
    vatMode: 'none',
    reason: 'Beleg geprüft',
  });
  assert.throws(() => eurClassificationBodySchema.parse({ sourceType: 'transaction', sourceId: 'ghost', taxYear: 2025, reason: '   ' }));
});

test('mapping overrides require an explicit reason and never accept arbitrary statement types', () => {
  assert.throws(() => mappingOverrideBodySchema.parse({ chart: 'SKR03', accountNumber: '8400', statementType: 'guv', positionKey: 'revenue', positionLabel: 'Umsatz' }));
  assert.throws(() => mappingOverrideBodySchema.parse({ chart: 'SKR03', accountNumber: '8400', statementType: 'guv', positionKey: 'revenue', positionLabel: 'Umsatz', reason: 'Kontenplan geprüft' }));
  assert.throws(() => mappingOverrideBodySchema.parse({ chart: 'SKR03', accountNumber: '8400', statementType: 'management-guv', positionKey: 'revenue', positionLabel: 'Umsatz', reason: 'Kontenplan geprüft' }));
  assert.equal(mappingOverrideBodySchema.parse({ chart: 'SKR03', asOfDate: '2026-03-31', accountNumber: '8400', statementType: 'management-guv', positionKey: 'revenue', positionLabel: 'Umsatz', reason: 'Kontenplan geprüft' }).balanceSide, undefined);
  assert.equal(mappingOverrideBodySchema.parse({ chart: 'SKR03', asOfDate: '2026-03-31', accountNumber: '1200', statementType: 'hgb-bilanz', positionKey: 'cash', positionLabel: 'Bank', balanceSide: 'asset', reason: 'Kontenplan geprüft' }).statementType, 'hgb-bilanz');
});

test('mapping position lists require the same explicit report date', () => {
  assert.throws(() => mappingPositionsQuerySchema.parse({ reportType: 'hgb-bilanz' }));
  assert.deepEqual(mappingPositionsQuerySchema.parse({ reportType: 'hgb-bilanz', asOfDate: '2026-03-31' }), { reportType: 'hgb-bilanz', asOfDate: '2026-03-31' });
});

test('mapping health can scope unmapped accounts to one canonical report', () => {
  assert.deepEqual(mappingHealthQuerySchema.parse({ chart: 'SKR04', reportType: 'hgb-bilanz', asOfDate: '2025-12-31' }), { chart: 'SKR04', reportType: 'hgb-bilanz', asOfDate: '2025-12-31' });
  assert.throws(() => mappingHealthQuerySchema.parse({ reportType: 'hgb-bilanz', asOfDate: '2025-12-32' }));
  assert.throws(() => mappingHealthQuerySchema.parse({ reportType: 'guv' }));
});

test('new accounting mutation boundaries require reason and idempotency', () => {
  assert.throws(() => closingCommandBodySchema.parse({ command: 'fiscal_close', reason: 'close' }));
  assert.throws(() => taxExportPreparationBodySchema.parse({ kind: 'ustva', period: '2025-01', reason: 'prepare' }));
  assert.throws(() => correctionSettlementBodySchema.parse({ id: 'c1', idempotencyKey: 'k1', correctionDate: '2025-01-31', original: { documentId: 'i1', documentNumber: 'R-1', revision: 'v1', snapshotHash: 'hash', taxEffectiveDate: '2025-01-01', taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19 }] }, deltas: [{ rate: 19, grossAmount: 10 }] }));
  assert.equal(closingCommandBodySchema.parse({ command: 'fiscal_close', sourceId: 'close-1', sourceRevision: 'v1', idempotencyKey: 'close-key', reason: 'Jahresabschluss' }).idempotencyKey, 'close-key');
  assert.equal(taxExportPreparationBodySchema.parse({ kind: 'ustva', period: '2025-01', idempotencyKey: 'tax-key', reason: 'UStVA vorbereiten' }).kind, 'ustva');
});

test('source-run and tax preparation routes enforce auth and mutation role before Postgres', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'accounting-source-runs-route-test-secret';
  const app = await buildServerApi();
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/pro/accounting/source-runs' });
    assert.equal(unauthorized.statusCode, 401);
    const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/pro/auth/bootstrap', payload: { email: 'source-runs-route@example.com', password: 'billme-server-123', fullName: 'Source Runs' } });
    assert.equal(bootstrap.statusCode, 200);
    const token = bootstrap.json().token as string;
    const viewerToken = app.tokenService.sign({ ...app.tokenService.verify(token)!, role: 'viewer' });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/accounting/closing',
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { command: 'fiscal_close', sourceId: 'close-1', sourceRevision: 'v1', idempotencyKey: 'close-key', reason: 'viewer must not mutate' },
    });
    assert.equal(forbidden.statusCode, 403);
    const missingIdempotency = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/accounting/closing',
      headers: { authorization: `Bearer ${token}` },
      payload: { command: 'fiscal_close', sourceId: 'close-1', sourceRevision: 'v1', reason: 'missing key' },
    });
    assert.equal(missingIdempotency.statusCode, 400);
  } finally {
    await app.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
});
