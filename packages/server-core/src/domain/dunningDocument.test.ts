import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDunningDocumentContext } from './dunningDocument.js';
import type { DunningHistoryEntry, DunningLevel } from './dunning.js';

const levels: DunningLevel[] = [
  { id: 1, name: 'Zahlungserinnerung', enabled: true, daysAfterDueDate: 7, fee: 0, subject: '', text: 'Die Rechnung %N vom %D ist noch offen.' },
  { id: 2, name: '1. Mahnung', enabled: true, daysAfterDueDate: 14, fee: 5, subject: '', text: '' },
  { id: 3, name: '2. Mahnung', enabled: true, daysAfterDueDate: 21, fee: 10, subject: '', text: '' },
];
const entry = (dunningLevel: number, feeApplied: number, processedAt: string): DunningHistoryEntry => ({
  id: `h${dunningLevel}`, invoiceId: 'i', invoiceNumber: 'RE-1', dunningLevel, daysOverdue: 0, feeApplied, emailSent: true, processedAt, createdAt: processedAt,
});

test('does not count fees twice: the run already added them to the invoice amount', () => {
  const invoice = { number: 'RE-1', date: '2026-08-01', dueDate: '2026-08-15', amount: 115, payments: [{ id: 'p', date: '2026-08-20', amount: 20, method: 'Überweisung' }], dunningLevel: 2 };
  const history = [entry(1, 0, '2026-08-22T09:00:00Z'), entry(2, 5, '2026-08-29T09:00:00Z')];
  const context = buildDunningDocumentContext({ invoice, levels, history, today: new Date('2026-09-27T10:00:00Z') });
  assert.equal(context.level, 2);
  assert.equal(context.originalAmount, 110);
  assert.equal(context.fee, 5);
  assert.equal(context.paidAmount, 20);
  assert.equal(context.date, '2026-08-29');
  assert.equal(context.payUntil, '2026-09-05');
  assert.equal(context.daysOverdue, 14);

  // Previewing the next level adds its configured fee on top of what was charged.
  const preview = buildDunningDocumentContext({ invoice, level: 3, levels, history, today: new Date('2026-09-27T10:00:00Z') });
  assert.equal(preview.fee, 15);
  assert.equal(preview.levelName, '2. Mahnung');
  assert.equal(preview.date, '2026-09-27');
});

test('turns the level text into the letter intro with placeholders', () => {
  const context = buildDunningDocumentContext({
    invoice: { number: 'RE-1', date: '2026-08-01', dueDate: '2026-08-15', amount: 100, payments: [], dunningLevel: 0 },
    levels, history: [], today: new Date('2026-08-22T10:00:00Z'),
  });
  assert.equal(context.level, 1);
  assert.equal(context.intro, 'Sehr geehrte Damen und Herren,\n\nDie Rechnung {{invoice.number}} vom {{invoice.date}} ist noch offen.\n\nBitte überweisen Sie den offenen Betrag bis zum {{dunning.payUntil}}.');
});
