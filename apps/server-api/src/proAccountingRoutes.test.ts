import assert from 'node:assert/strict';
import test from 'node:test';
import { csvEscape, datevExportQuerySchema, susaReportQuerySchema } from './proAccountingRoutes.js';

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
