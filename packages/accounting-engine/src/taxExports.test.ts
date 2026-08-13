import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateOss,
  aggregateZm,
  prepareEBilanz,
  prepareUstva,
  prepareUnternehmensregister,
  TaxExportError,
  validateTaxExportProvider,
} from './taxExports.js';

const catalog = {
  id: 'ustva-2025',
  taxYear: 2025,
  version: '2025.1',
  source: 'official-catalog',
  sourceHash: 'a'.repeat(64),
  entries: [{ taxCaseKey: 'DE_STD_19' as const, kennziffer: '81', direction: 'output' as const }],
};

test('prepares UStVA output by canonical tax case and catalog Kennziffer', () => {
  const result = prepareUstva({
    period: '2025-01',
    catalog,
    entries: [{
      postingDate: '2025-01-15',
      status: 'posted',
      lines: [{ taxCaseKey: 'DE_STD_19', netAmount: 100.005, taxAmount: 19.005 }],
    }],
  });

  assert.equal(result.status, 'prepared');
  assert.equal(result.submissionReady, false);
  assert.deepEqual(result.rows, [{
    taxCaseKey: 'DE_STD_19',
    kennziffer: '81',
    direction: 'output',
    netAmount: 100.01,
    taxAmount: 19.01,
    lineCount: 1,
  }]);
});

test('ZM groups EU supplies by VAT ID and tax case and nets reversals', () => {
  const result = aggregateZm({
    period: '2025-01',
    entries: [
      { postingDate: '2025-01-02', status: 'posted', lines: [{ taxCaseKey: 'EU_IGL_GOODS_0', netAmount: 100, countryCode: 'FR', counterpartyVatId: 'FR12345678901', evidenceType: 'transport', evidenceReference: 'CMR-1' }] },
      { postingDate: '2025-01-20', status: 'reversed', lines: [{ taxCaseKey: 'EU_IGL_GOODS_0', netAmount: -20, countryCode: 'FR', counterpartyVatId: 'FR12345678901', evidenceType: 'transport', evidenceReference: 'CMR-1' }] },
    ],
  });
  assert.deepEqual(result.rows, [{ taxCaseKey: 'EU_IGL_GOODS_0', countryCode: 'FR', counterpartyVatId: 'FR12345678901', netAmount: 80, lineCount: 2 }]);
  assert.equal(result.submissionReady, false);
});

test('OSS groups B2C by destination country and rate without a VAT ID', () => {
  const result = aggregateOss({
    period: '2025-Q1',
    entries: [{ postingDate: '2025-02-01', status: 'posted', lines: [
      { taxCaseKey: 'EU_B2C_OSS', countryCode: 'AT', taxRate: 20, netAmount: 50, taxAmount: 10 },
      { taxCaseKey: 'EU_B2C_OSS', countryCode: 'AT', taxRate: 20, netAmount: -10, taxAmount: -2, counterpartyVatId: undefined },
    ] }],
  });
  assert.deepEqual(result.rows, [{ countryCode: 'AT', taxRate: 20, netAmount: 40, taxAmount: 8, lineCount: 2 }]);
});

test('preparation artifacts bind report provenance and stay fail-closed', () => {
  const reportSnapshot = { id: 'report-1', sourceHash: 'b'.repeat(64) };
  const eBilanz = prepareEBilanz({ period: '2025-01', reportSnapshot, taxonomy: '6.9', facts: [{ concept: 'Assets', value: 100 }] });
  assert.equal(eBilanz.reportSnapshot.reportSnapshotId, 'report-1');
  assert.equal(eBilanz.submissionReady, false);
  const register = prepareUnternehmensregister({ period: '2025-01', reportSnapshot, companyName: 'Example GmbH', registerNumber: 'HRB 123' });
  assert.equal(register.operation, 'preparation');
  assert.throws(() => validateTaxExportProvider(), (error: unknown) => error instanceof TaxExportError && error.code === 'PROVIDER_CATALOG_UNAVAILABLE');
});

test('non-happy tax export evidence and catalog inputs fail closed', () => {
  assert.throws(() => aggregateZm({
    period: '2025-01',
    entries: [{ postingDate: '2025-01-02', status: 'posted', lines: [{ taxCaseKey: 'EU_B2B_SERVICE_RC', netAmount: 100, countryCode: 'FR', counterpartyVatId: 'FR12345678901' }] }],
  }), (error: unknown) => error instanceof TaxExportError && error.code === 'MISSING_EVIDENCE');
  assert.throws(() => aggregateOss({
    period: '2025-01',
    entries: [{ postingDate: '2025-01-02', status: 'posted', lines: [{ taxCaseKey: 'EU_B2C_OSS', netAmount: 100, countryCode: 'XX', taxRate: 20 }] }],
  }), (error: unknown) => error instanceof TaxExportError && error.code === 'INVALID_COUNTRY');
  assert.throws(() => aggregateOss({
    period: '2025-01',
    entries: [{ postingDate: '2025-01-02', status: 'posted', lines: [{ taxCaseKey: 'EU_B2C_OSS', netAmount: 100, countryCode: 'AT', taxRate: 20.001 }] }],
  }), (error: unknown) => error instanceof TaxExportError && error.code === 'INVALID_RATE');
  assert.throws(() => prepareEBilanz({ period: '2025-01', reportSnapshot: { id: 'report-1', sourceHash: 'b'.repeat(64) }, taxonomy: '6.8', facts: [] }), (error: unknown) => error instanceof TaxExportError && error.code === 'TAXONOMY_MISMATCH');
  assert.throws(() => prepareUstva({ period: '2024-01', catalog, entries: [] }), (error: unknown) => error instanceof TaxExportError && error.code === 'UNSUPPORTED_YEAR');
});
