import { describe, expect, it } from 'vitest';
import { monthToFirstDay, monthToLastDay, reportDateRange } from './reportDates';

describe('report date ranges', () => {
  it('expands a December month filter to inclusive ISO bounds', () => {
    expect(monthToFirstDay('2026-12')).toBe('2026-12-01');
    expect(monthToLastDay('2026-12')).toBe('2026-12-31');
    expect(reportDateRange({ periodFrom: '2026-12', periodTo: '2026-12', asOfDate: '2026-12-12' })).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});
