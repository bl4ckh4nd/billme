import { describe, expect, it } from 'vitest';
import { getBwaReport, getEurReport, getHgbGuvReport } from './mockReportService';

const filters = {
  chart: 'SKR03' as const,
  asOfDate: '2026-08-12',
  periodFrom: '2026-01',
  periodTo: '2026-08',
  compareMode: 'none' as const,
  includeDrafts: false,
};

describe('mock report profiles', () => {
  it('keeps hierarchical account references while exposing profile reports', async () => {
    const [eur, bwa, hgb] = await Promise.all([getEurReport(filters), getBwaReport(filters), getHgbGuvReport(filters)]);
    expect(eur.lines.some((line) => line.children?.length)).toBe(true);
    expect(bwa.lines.flatMap((line) => line.accountRefs ?? [])).toContain('4400');
    expect(hgb.totals.result).toBe(-3510);
  });

  it('scales prior-year reports without mutating the fixture', async () => {
    const report = await getHgbGuvReport({ ...filters, periodPreset: 'prev_year' });
    expect(report.totals.result).toBe(-3018.6);
  });
});
