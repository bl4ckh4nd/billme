import assert from 'node:assert/strict';
import test from 'node:test';
import { businessReportingProfileSchema, openItemSchema } from './schemas.ts';

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
