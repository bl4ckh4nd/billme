import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountingSourceFactSchema,
  businessReportingProfileSchema,
  journalEntryEntitySchema,
  openItemSchema,
  proAccountingSourcePostResultSchema,
  proAccountingSourceRunSchema,
  proPostAccountingCommandArgsSchema,
  proPostAccountingSourceArgsSchema,
  standaloneAccountingSourceFactSchema,
} from './schemas.ts';

const journalEntry = (sourceType: string) => ({
  id: 'journal-1',
  tenantId: 'tenant-1',
  entryNumber: 1,
  postingDate: '2026-08-14',
  bookingText: 'Testbuchung',
  period: '2026-08',
  fiscalYear: 2026,
  status: 'posted' as const,
  sourceType,
  createdAt: '2026-08-14T00:00:00.000Z',
  lines: [],
});

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

test('accepts every supported journal source type', () => {
  const sourceTypes = [
    'booking_draft',
    'reversal',
    'depreciation',
    'manual',
    'outgoing_invoice',
    'incoming_invoice',
    'payment',
    'payment_vat',
    'legacy_transaction',
    'asset_activation',
    'asset_depreciation',
    'asset_disposal',
    'standalone_source',
    'fiscal_close',
    'carry_forward',
    'provision',
    'accrual',
    'inventory_closing',
    'fx_valuation',
    'loan_schedule',
    'payroll_batch',
    'shareholder_flow',
  ];

  for (const sourceType of sourceTypes) {
    assert.equal(journalEntryEntitySchema.parse(journalEntry(sourceType)).sourceType, sourceType);
  }
});

test('rejects unknown journal source types', () => {
  assert.throws(() => journalEntryEntitySchema.parse(journalEntry('unknown_source')));
});

test('accepts server-emitted shareholder flow source runs and rejects unknown source types', () => {
  const source = { ...sourceFact(), sourceType: 'shareholder_flow' as const };
  const sourceRun = {
    id: 'run-1',
    tenantId: 'tenant-1',
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    idempotencyKey: 'shareholder_flow:source-1:1',
    fact: source,
    result: { status: 'posted' },
    status: 'posted' as const,
    journalEntryId: 'journal-1',
    createdAt: '2026-08-14T00:00:00.000Z',
  };

  assert.equal(proAccountingSourceRunSchema.parse(sourceRun).fact.sourceType, 'shareholder_flow');
  assert.throws(() => proAccountingSourceRunSchema.parse({ ...sourceRun, sourceType: 'unknown_source' }));
  assert.throws(() => proAccountingSourceRunSchema.parse({ ...sourceRun, fact: { ...source, sourceType: 'unknown_source' } }));
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

test('requires explicit settlement accounts in domain facts', () => {
  const source = sourceFact([]);
  assert.throws(() => proPostAccountingCommandArgsSchema.parse({ kind: 'bad_debt', source, domainFacts: { taxBreakdown: [] }, reason: 'Ausfall geprüft' }), /badDebtExpenseAccount/);
  assert.deepEqual(
    proPostAccountingCommandArgsSchema.parse({ kind: 'advance_settlement', source, domainFacts: { advanceClearingReceivable: '1593', advanceClearingPayable: '1518' }, reason: 'Vorauszahlung geprüft' }).domainFacts,
    { advanceClearingReceivable: '1593', advanceClearingPayable: '1518' },
  );
});


test('preserves typed settlement error details across the IPC result contract', () => {
  const result = proAccountingSourcePostResultSchema.parse({
    status: 'rejected',
    errors: [{
      code: 'OVER_CREDIT',
      message: 'settlement exceeds final invoice amount for VAT rate 19',
      field: 'domainFacts.advances[0].grossAmount',
      details: { remaining: 11.9 },
      blocking: true,
    }],
    idempotencyKey: 'standalone_source:source-1:r1',
  });
  assert.deepEqual(result.errors[0], {
    code: 'OVER_CREDIT',
    message: 'settlement exceeds final invoice amount for VAT rate 19',
    field: 'domainFacts.advances[0].grossAmount',
    details: { remaining: 11.9 },
    blocking: true,
  });
});
