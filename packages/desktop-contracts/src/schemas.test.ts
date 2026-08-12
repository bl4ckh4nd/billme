import assert from 'node:assert/strict';
import test from 'node:test';
import { businessReportingProfileSchema } from './schemas.ts';

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
