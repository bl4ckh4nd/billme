import { fiscalYearForDate, fiscalYearRange, type FiscalYearRange } from '@billme/accounting-shared';
import type { BusinessReportingProfile, ReportFilterState, ReportPeriodPreset } from './reportTypes';

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/** Native EÜR is currently a print-only 2025 filing surface. */
export const NATIVE_EUR_2025_RANGE = Object.freeze({
  from: '2025-01-01',
  to: '2025-12-31',
  label: '2025',
});

export const monthToFirstDay = (month?: string): string | undefined => {
  const match = month?.match(MONTH_PATTERN);
  if (!match) return undefined;
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return undefined;
  return `${match[1]}-${match[2]}-01`;
};

export const monthToLastDay = (month?: string): string | undefined => {
  const match = month?.match(MONTH_PATTERN);
  if (!match) return undefined;
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return undefined;
  const lastDay = new Date(Date.UTC(Number(match[1]), monthNumber, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
};

const calendarYearRange = (asOfDate: string): FiscalYearRange => {
  const year = Number(asOfDate.slice(0, 4));
  return { fiscalYear: year, start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
};

/**
 * Returns the canonical report year for the profile. EÜR deliberately remains
 * calendar-based; double-entry GmbH reports use the persisted MM-DD start.
 * Invalid setup is represented as undefined so the UI can block with setup
 * guidance instead of implementing a second validation rule.
 */
export const reportFiscalYearRange = (asOfDate: string, profile?: BusinessReportingProfile): FiscalYearRange | undefined => {
  if (!profile || profile.legalForm !== 'gmbh' || profile.profitDetermination !== 'double_entry') {
    return calendarYearRange(asOfDate);
  }
  if (!profile.fiscalYearStart) return undefined;
  try {
    return fiscalYearRange(fiscalYearForDate(asOfDate, profile.fiscalYearStart), profile.fiscalYearStart);
  } catch {
    return undefined;
  }
};

export const reportPeriodRangeForPreset = (
  asOfDate: string,
  profile: BusinessReportingProfile | undefined,
  periodPreset: ReportPeriodPreset = 'current',
): { from: string; to: string } | undefined => {
  const current = reportFiscalYearRange(asOfDate, profile);
  if (!current) return undefined;
  if (periodPreset === 'ytd') return { from: current.start, to: asOfDate };
  if (periodPreset === 'prev_year') {
    if (profile?.legalForm === 'gmbh' && profile.profitDetermination === 'double_entry' && profile.fiscalYearStart) {
      try {
        const previous = fiscalYearRange(current.fiscalYear - 1, profile.fiscalYearStart);
        return { from: previous.start, to: previous.end };
      } catch {
        return undefined;
      }
    }
    const previous = calendarYearRange(asOfDate);
    return { from: `${previous.fiscalYear - 1}-01-01`, to: `${previous.fiscalYear - 1}-12-31` };
  }
  return { from: current.start, to: current.end };
};

export const defaultReportFilters = (
  chart: 'SKR03' | 'SKR04' = 'SKR03',
  businessReportingProfile?: BusinessReportingProfile,
  asOfDate = new Date().toISOString().slice(0, 10),
): ReportFilterState => {
  const range = reportFiscalYearRange(asOfDate, businessReportingProfile) ?? calendarYearRange(asOfDate);
  return {
    chart,
    asOfDate,
    periodFrom: range.start.slice(0, 7),
    periodTo: range.end.slice(0, 7),
    periodFromDate: range.start,
    periodToDate: range.end,
    compareMode: 'none',
    includeDrafts: false,
    periodPreset: 'current',
    businessReportingProfile,
  };
};

export const reportDateRange = ({
  periodFrom,
  periodTo,
  periodFromDate,
  periodToDate,
  asOfDate,
  periodPreset,
  businessReportingProfile,
}: Pick<ReportFilterState, 'periodFrom' | 'periodTo' | 'periodFromDate' | 'periodToDate' | 'asOfDate' | 'periodPreset' | 'businessReportingProfile'>) => {
  if (periodFromDate || periodToDate) {
    return {
      from: periodFromDate ?? monthToFirstDay(periodFrom),
      to: periodToDate ?? monthToLastDay(periodTo) ?? asOfDate,
    };
  }
  const presetRange = periodPreset ? reportPeriodRangeForPreset(asOfDate, businessReportingProfile, periodPreset) : undefined;
  if (presetRange) return presetRange;
  return {
    from: periodFromDate ?? monthToFirstDay(periodFrom),
    to: periodToDate ?? monthToLastDay(periodTo) ?? asOfDate,
  };
};

export const periodPresetRange = (filters: ReportFilterState) => {
  return reportDateRange(filters);
};
