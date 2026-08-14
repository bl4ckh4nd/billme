import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSettlementJournalCommand } from './settlementCommands.js';

const source = { sourceId: 'settlement-1', sourceRevision: 'v1', effectiveDate: '2026-03-15', postingDate: '2026-03-15', period: '2026-03', fiscalYear: 2026, currency: 'EUR' };
const accounts = { accountsReceivable: '1400', accountsPayable: '1600', revenue: '8400', expense: '4900', badDebtExpenseAccount: '2400', advanceClearingReceivable: '1593', advanceClearingPayable: '1518', outputVat: '1776', inputVat: '1576' };
const total = (lines: Array<{ debitAmount: number; creditAmount: number }>) => ({ debit: lines.reduce((sum, line) => sum + Math.round(line.debitAmount * 100), 0), credit: lines.reduce((sum, line) => sum + Math.round(line.creditAmount * 100), 0) });

test('settlement workflows derive balanced, evidenced journal commands', () => {
  const skonto = buildSettlementJournalCommand({ kind: 'skonto', source, accounts, facts: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], skontoAmount: 11.9 } });
  assert.deepEqual(total(skonto.command.entry.lines), { debit: 1190, credit: 1190 });
  assert.deepEqual(skonto.command.entry.lines.map(({ accountNumber, debitAmount, creditAmount }) => ({ accountNumber, debitAmount, creditAmount })), [
    { accountNumber: '8400', debitAmount: 10, creditAmount: 0 },
    { accountNumber: '1776', debitAmount: 1.9, creditAmount: 0 },
    { accountNumber: '1400', debitAmount: 0, creditAmount: 11.9 },
  ]);
  assert.equal(skonto.command.entry.lines.filter((line) => line.taxCaseKey).length, 1);
  assert.equal(skonto.command.entry.lines.find((line) => line.taxCaseKey)?.evidenceType, 'skonto');
  const badDebt = buildSettlementJournalCommand({ kind: 'bad_debt', source, accounts, facts: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], writeOffGrossAmount: 119, facts: { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: 'invoice-1', originalDocumentNumber: 'RE-1', originalTaxEffectiveDate: '2026-03-01', adjustmentDate: '2026-03-15', evidenceReference: 'case-1' } } });
  assert.deepEqual(total(badDebt.command.entry.lines), { debit: 11900, credit: 11900 });
  assert.equal(badDebt.command.entry.lines.find((line) => line.id.endsWith(':base:1'))?.accountNumber, '2400');
  assert.equal(badDebt.command.entry.lines.find((line) => line.taxCaseKey)?.evidenceReference, 'case-1');
  const advance = buildSettlementJournalCommand({ kind: 'advance_settlement', source, accounts, facts: { finalInvoice: { grossAmount: 119, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] }, advances: [{ id: 'advance-1', kind: 'advance', grossAmount: 59.5 }] } });
  assert.deepEqual(total(advance.command.entry.lines), { debit: 5950, credit: 5950 });
  assert.deepEqual(advance.command.entry.lines.map((line) => line.accountNumber), ['1593', '1400']);
  assert.equal(advance.command.entry.lines.some((line) => line.accountNumber === '8400' || line.taxCaseKey), false);
  const incomingAdvance = buildSettlementJournalCommand({ kind: 'advance_settlement', source, accounts, facts: { documentType: 'incoming_invoice', finalInvoice: { grossAmount: 119, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] }, advances: [{ id: 'advance-1', kind: 'advance', grossAmount: 59.5 }] } });
  assert.deepEqual(incomingAdvance.command.entry.lines.map((line) => line.accountNumber), ['1600', '1518']);
});

test('settlement VAT metadata is conserved on economic lines only', () => {
  const result = buildSettlementJournalCommand({ kind: 'skonto', source, accounts, facts: {
    taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }, { rate: 7, netAmount: 50, taxAmount: 3.5, grossAmount: 53.5 }],
    skontoAmount: 20,
  } });
  const economicLines = result.command.entry.lines.filter((line) => line.taxCaseKey);
  assert.deepEqual(economicLines.reduce((summary, line) => ({
    net: summary.net + Math.round((line.netAmount ?? 0) * 100),
    tax: summary.tax + Math.round((line.taxAmount ?? 0) * 100),
    gross: summary.gross + Math.round((line.grossAmount ?? 0) * 100),
  }), { net: 0, tax: 0, gross: 0 }), {
    net: Math.round(result.result.discountNetAmount * 100),
    tax: Math.round(result.result.discountTaxAmount * 100),
    gross: Math.round(result.result.discountGrossAmount * 100),
  });
  assert.equal(result.command.entry.lines.filter((line) => line.accountNumber === '1776').every((line) => !line.taxCaseKey && line.netAmount === undefined && line.taxAmount === undefined && line.grossAmount === undefined), true);
});

test('settlement totals cannot silently produce an empty or unaccounted journal', () => {
  assert.throws(() => buildSettlementJournalCommand({ kind: 'skonto', source, accounts, facts: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], skontoAmount: 0 } }), /positive journal amount/);
  assert.throws(() => buildSettlementJournalCommand({ kind: 'bad_debt', source, accounts: { ...accounts, badDebtExpenseAccount: undefined }, facts: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], writeOffGrossAmount: 119, facts: { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: 'invoice-1', originalDocumentNumber: 'RE-1', originalTaxEffectiveDate: '2026-03-01', adjustmentDate: '2026-03-15', evidenceReference: 'case-1' } } }), /explicit bad-debt expense account/);
  assert.throws(() => buildSettlementJournalCommand({ kind: 'advance_settlement', source, accounts: { ...accounts, advanceClearingReceivable: undefined }, facts: { finalInvoice: { grossAmount: 119, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] }, advances: [{ id: 'advance-1', kind: 'advance', grossAmount: 119 }] } }), /advanceClearingReceivable/);
  assert.throws(() => buildSettlementJournalCommand({ kind: 'advance_settlement', source, accounts: { ...accounts, advanceClearingPayable: undefined }, facts: { documentType: 'incoming_invoice', finalInvoice: { grossAmount: 119, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] }, advances: [{ id: 'advance-1', kind: 'advance', grossAmount: 119 }] } }), /advanceClearingPayable/);
  const fullySettled = buildSettlementJournalCommand({ kind: 'advance_settlement', source, accounts, facts: { finalInvoice: { grossAmount: 119, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] }, advances: [{ id: 'advance-1', kind: 'advance', grossAmount: 119 }] } });
  assert.deepEqual(total(fullySettled.command.entry.lines), { debit: 11900, credit: 11900 });
});
