import { describe, expect, it } from 'vitest';
import {
  defaultReportFilters,
  monthToFirstDay,
  monthToLastDay,
  reportDateRange,
  reportFiscalYearRange,
  reportPeriodRangeForPreset,
} from './reportDates';

describe('report date ranges', () => {
  it('expands a December month filter to inclusive ISO bounds', () => {
    expect(monthToFirstDay('2026-12')).toBe('2026-12-01');
    expect(monthToLastDay('2026-12')).toBe('2026-12-31');
    expect(reportDateRange({ periodFrom: '2026-12', periodTo: '2026-12', asOfDate: '2026-12-12' })).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });

  it('uses the canonical fiscal-year boundary for GmbH reports', () => {
    const profile = { legalForm: 'gmbh' as const, profitDetermination: 'double_entry' as const, fiscalYearStart: '04-15' };
    expect(reportFiscalYearRange('2026-04-14', profile)).toMatchObject({
      fiscalYear: 2025,
      start: '2025-04-15',
      end: '2026-04-14',
    });
    expect(reportFiscalYearRange('2026-04-15', profile)).toMatchObject({
      fiscalYear: 2026,
      start: '2026-04-15',
      end: '2027-04-14',
    });
    expect(defaultReportFilters('SKR03', profile, '2026-04-14').periodFromDate).toBe('2025-04-15');
    expect(reportPeriodRangeForPreset('2026-04-14', profile, 'ytd')).toEqual({ from: '2025-04-15', to: '2026-04-14' });
  });

  it('keeps EÜR periods on the calendar year', () => {
    const profile = { legalForm: 'sole_proprietor' as const, profitDetermination: 'eur' as const, fiscalYearStart: '04-15' };
    expect(reportPeriodRangeForPreset('2026-04-14', profile, 'current')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(reportDateRange({
      ...defaultReportFilters('SKR03', profile, '2026-04-14'),
      periodPreset: 'current',
    })).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});
