import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSettlementJournalCommand } from './settlementCommands.js';

const source = { sourceId: 'settlement-1', sourceRevision: 'v1', effectiveDate: '2026-03-15', postingDate: '2026-03-15', period: '2026-03', fiscalYear: 2026, currency: 'EUR' };
const accounts = { accountsReceivable: '1400', accountsPayable: '1600', revenue: '8400', expense: '4900', outputVat: '1776', inputVat: '1576' };
const total = (lines: Array<{ debitAmount: number; creditAmount: number }>) => ({ debit: lines.reduce((sum, line) => sum + Math.round(line.debitAmount * 100), 0), credit: lines.reduce((sum, line) => sum + Math.round(line.creditAmount * 100), 0) });

test('settlement workflows derive balanced, evidenced journal commands', () => {
  const skonto = buildSettlementJournalCommand({ kind: 'skonto', source, accounts, facts: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], skontoAmount: 11.9 } });
  assert.deepEqual(total(skonto.command.entry.lines), { debit: 1190, credit: 1190 });
  assert.equal(skonto.command.entry.lines.find((line) => line.taxCaseKey)?.evidenceType, 'skonto');
  const badDebt = buildSettlementJournalCommand({ kind: 'bad_debt', source, accounts, facts: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], writeOffGrossAmount: 119, facts: { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: 'invoice-1', originalDocumentNumber: 'RE-1', originalTaxEffectiveDate: '2026-03-01', adjustmentDate: '2026-03-15', evidenceReference: 'case-1' } } });
  assert.deepEqual(total(badDebt.command.entry.lines), { debit: 11900, credit: 11900 });
  assert.equal(badDebt.command.entry.lines.find((line) => line.taxCaseKey)?.evidenceReference, 'case-1');
  const advance = buildSettlementJournalCommand({ kind: 'advance_settlement', source, accounts, facts: { finalInvoice: { grossAmount: 119, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] }, advances: [{ id: 'advance-1', kind: 'advance', grossAmount: 59.5 }] } });
  assert.deepEqual(total(advance.command.entry.lines), { debit: 5950, credit: 5950 });
});

test('settlement totals cannot silently produce an empty journal', () => {
  assert.throws(() => buildSettlementJournalCommand({ kind: 'skonto', source, accounts, facts: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], skontoAmount: 0 } }), /positive journal amount/);
  assert.throws(() => buildSettlementJournalCommand({ kind: 'advance_settlement', source, accounts, facts: { finalInvoice: { grossAmount: 119, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] }, advances: [{ id: 'advance-1', kind: 'advance', grossAmount: 119 }] } }), /positive journal amount/);
});
