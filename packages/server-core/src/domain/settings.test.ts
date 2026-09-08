import assert from 'node:assert/strict';
import test from 'node:test';
import { businessReportingProfileSchema } from './settings.js';

test('business reporting profile enforces GmbH double-entry requirements', () => {
  assert.throws(() => businessReportingProfileSchema.parse({
    jurisdiction: 'DE',
    legalForm: 'gmbh',
    profitDetermination: 'eur',
    fiscalYearStart: '01-01',
    vatMethod: 'soll',
  }));
  assert.deepEqual(businessReportingProfileSchema.parse({
    jurisdiction: 'DE',
    legalForm: 'gmbh',
    profitDetermination: 'double_entry',
    hgbSizeClass: 'small',
    fiscalYearStart: '04-01',
    chart: 'SKR04',
    vatMethod: 'ist',
  }), {
    jurisdiction: 'DE',
    legalForm: 'gmbh',
    profitDetermination: 'double_entry',
    hgbSizeClass: 'small',
    fiscalYearStart: '04-01',
    chart: 'SKR04',
    vatMethod: 'ist',
  });
});

test('EÜR is restricted to the calendar year', () => {
  assert.throws(() => businessReportingProfileSchema.parse({
    jurisdiction: 'DE',
    legalForm: 'sole_proprietor',
    profitDetermination: 'eur',
    fiscalYearStart: '04-01',
    vatMethod: 'soll',
  }));
});

test('sole proprietors cannot use double-entry accounting', () => {
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

test('rejects impossible month-day values', () => {
  assert.throws(() => businessReportingProfileSchema.parse({
    jurisdiction: 'DE',
    legalForm: 'sole_proprietor',
    profitDetermination: 'double_entry',
    fiscalYearStart: '02-31',
    vatMethod: 'soll',
  }));
});
