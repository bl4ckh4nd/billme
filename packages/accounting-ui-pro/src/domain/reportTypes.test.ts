import { describe, expect, it } from 'vitest';
import { reportTabsForBusinessProfile } from './reportTypes';

describe('report tabs for business profile', () => {
  it('fails closed without a reporting profile', () => {
    expect(reportTabsForBusinessProfile()).toEqual(['susa']);
  });

  it('exposes EÜR reports only for sole proprietors using EÜR', () => {
    expect(reportTabsForBusinessProfile({ legalForm: 'sole_proprietor', profitDetermination: 'eur' })).toEqual([
      'eur', 'susa', 'bwa01', 'management_guv',
    ]);
  });

  it('exposes HGB reports only for GmbH double-entry accounting', () => {
    expect(reportTabsForBusinessProfile({ legalForm: 'gmbh', profitDetermination: 'double_entry' })).toEqual([
      'susa', 'bwa01', 'management_guv', 'hgb_guv', 'bilanz',
    ]);
  });
});
