import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountingSourceFactSchema,
  businessReportingProfileSchema,
  openItemSchema,
  proPostAccountingCommandArgsSchema,
  proPostAccountingSourceArgsSchema,
  standaloneAccountingSourceFactSchema,
} from './schemas.ts';

const sourceFact = (lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number }> = []) => ({
  sourceType: 'standalone_source' as const,
  sourceId: 'source-1',
  sourceRevision: '1',
  effectiveDate: '2026-08-14',
  postingDate: '2026-08-14',
  period: '2026-08',
  fiscalYear: 2026,
  currency: 'EUR',
  bookingText: 'Testbuchung',
  lines,
});

test('rejects unsupported sole-proprietor double-entry profiles', () => {
  assert.throws(
    () => businessReportingProfileSchema.parse({
      jurisdiction: 'DE',
      legalForm: 'sole_proprietor',
      profitDetermination: 'double_entry',
      fiscalYearStart: '01-01',
      vatMethod: 'soll',
    }),
    /Sole proprietors require EÜR/,
  );
});

test('accepts correction open items returned by the server accounting ledger', () => {
  const item = openItemSchema.parse({
    id: 'correction-open-item:c1',
    tenantId: 'tenant-1',
    partyType: 'creditor',
    partyId: 'vendor-1',
    sourceType: 'correction',
    sourceId: 'c1',
    documentNumber: 'Korrektur ER-1',
    documentDate: '2026-11-20',
    dueDate: '2026-11-20',
    originalAmount: 11.9,
    allocatedAmount: 0,
    residualAmount: 11.9,
    status: 'open',
    journalEntryId: 'journal-c1',
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  });
  assert.equal(item.sourceType, 'correction');
});

test('requires balanced non-empty lines for standalone source posting', () => {
  const balanced = sourceFact([
    { accountNumber: '1200', debitAmount: 100, creditAmount: 0 },
    { accountNumber: '8400', debitAmount: 0, creditAmount: 100 },
  ]);
  assert.deepEqual(standaloneAccountingSourceFactSchema.parse(balanced).lines, balanced.lines);
  assert.deepEqual(proPostAccountingSourceArgsSchema.parse({ source: balanced, reason: 'Source geprüft' }).source.lines, balanced.lines);
  assert.throws(() => standaloneAccountingSourceFactSchema.parse(sourceFact()), /At least one journal line/);
  assert.throws(() => proPostAccountingSourceArgsSchema.parse({ source: sourceFact([
    { accountNumber: '1200', debitAmount: 100, creditAmount: 0 },
  ]), reason: 'Source geprüft' }), /Debit and credit/);
});

test('allows empty lines only for domain commands with domain facts', () => {
  const source = sourceFact([]);
  assert.deepEqual(accountingSourceFactSchema.parse(source).lines, []);
  assert.deepEqual(
    proPostAccountingCommandArgsSchema.parse({ kind: 'fiscal_close', source, domainFacts: { closingDate: '2026-08-14' }, reason: 'Abschluss geprüft' }).source.lines,
    [],
  );
  assert.throws(() => proPostAccountingCommandArgsSchema.parse({ kind: 'fiscal_close', source, reason: 'Abschluss geprüft' }), /Domain facts are required/);
  assert.throws(() => proPostAccountingCommandArgsSchema.parse({ kind: 'standalone', source, domainFacts: { ignored: true }, reason: 'Source geprüft' }), /At least one journal line/);
  assert.throws(() => proPostAccountingCommandArgsSchema.parse({ kind: 'fiscal_close', source, domainFacts: [], reason: 'Abschluss geprüft' }), /Domain facts are required/);
});
