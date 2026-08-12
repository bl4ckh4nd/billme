import type { ReportFilterState } from './reportTypes';

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

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

export const reportDateRange = ({ periodFrom, periodTo, asOfDate, periodPreset }: Pick<ReportFilterState, 'periodFrom' | 'periodTo' | 'asOfDate' | 'periodPreset'>) => {
  const yearOffset = periodPreset === 'prev_year' ? -1 : 0;
  const shiftYear = (value?: string) => value ? `${Number(value.slice(0, 4)) + yearOffset}${value.slice(4)}` : undefined;
  return {
    from: shiftYear(monthToFirstDay(periodFrom)),
    to: shiftYear(monthToLastDay(periodTo) ?? asOfDate),
  };
};

export const periodPresetRange = (filters: ReportFilterState) => {
  return reportDateRange(filters);
};
