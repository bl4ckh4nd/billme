import { FileDown, FileText, RotateCcw } from 'lucide-react';
import { Button } from '@billme/ui';
import { ReportFilterState, ReportTabId } from '../../domain/reportTypes';
import { defaultReportFilters, NATIVE_EUR_2025_RANGE, reportPeriodRangeForPreset } from '../../domain/reportDates';

interface ReportToolbarProps {
  filters: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
  activeTab?: ReportTabId;
  onExport?: (format: 'pdf' | 'csv') => void;
  exporting?: boolean;
  exportBlockedReason?: string;
  /** Native EÜR is currently a fixed, print-only 2025 report. */
  lockNativeEurPeriod?: boolean;
}

export default function ReportToolbar({ filters, onChange, activeTab, onExport, exporting = false, exportBlockedReason, lockNativeEurPeriod = false }: ReportToolbarProps) {
  const nativeEurPeriodDescriptionId = 'native-eur-period-description';
  const forceNativeEurPeriod = () => onChange({
    ...filters,
    asOfDate: NATIVE_EUR_2025_RANGE.to,
    periodFrom: NATIVE_EUR_2025_RANGE.from.slice(0, 7),
    periodTo: NATIVE_EUR_2025_RANGE.to.slice(0, 7),
    periodFromDate: NATIVE_EUR_2025_RANGE.from,
    periodToDate: NATIVE_EUR_2025_RANGE.to,
    periodPreset: 'current',
    compareMode: 'none',
  });
  const setPreset = (periodPreset: ReportFilterState['periodPreset']) => {
    if (lockNativeEurPeriod) {
      forceNativeEurPeriod();
      return;
    }
    const nextPreset = periodPreset ?? 'current';
    const range = reportPeriodRangeForPreset(filters.asOfDate, filters.businessReportingProfile, nextPreset);
    onChange({
      ...filters,
      periodPreset: nextPreset,
      periodFrom: range?.from.slice(0, 7) ?? filters.periodFrom,
      periodTo: range?.to.slice(0, 7) ?? filters.periodTo,
      periodFromDate: range?.from,
      periodToDate: range?.to,
      compareMode: nextPreset === 'prev_year' ? 'prev_year' : 'none',
    });
  };
  const setAsOfDate = (asOfDate: string) => {
    if (lockNativeEurPeriod) {
      forceNativeEurPeriod();
      return;
    }
    const range = filters.periodPreset
      ? reportPeriodRangeForPreset(asOfDate, filters.businessReportingProfile, filters.periodPreset)
      : undefined;
    onChange({
      ...filters,
      asOfDate,
      periodFrom: range?.from.slice(0, 7) ?? filters.periodFrom,
      periodTo: range?.to.slice(0, 7) ?? filters.periodTo,
      periodFromDate: range?.from ?? filters.periodFromDate,
      periodToDate: range?.to ?? filters.periodToDate,
    });
  };

  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 space-y-2">
      {lockNativeEurPeriod ? (
        <p id={nativeEurPeriodDescriptionId} className="text-xs text-muted" role="status">
          Die native EÜR ist derzeit nur für das Druckformular 2025 verfügbar. Der Zeitraum ist deshalb fest auf 01.01.2025–31.12.2025 eingestellt.
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Zeitraum
          <select
            aria-label="Zeitraum"
            value={filters.periodPreset ?? 'current'}
            onChange={(event) => setPreset(event.target.value as ReportFilterState['periodPreset'])}
            disabled={lockNativeEurPeriod}
            aria-describedby={lockNativeEurPeriod ? nativeEurPeriodDescriptionId : undefined}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm"
          >
            <option value="current">Aktuelle Periode</option>
            <option value="ytd">Jahr bis heute</option>
            <option value="prev_year">Vorjahr</option>
          </select>
        </label>
        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Stichtag
          <input
            type="date"
            value={filters.asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            disabled={lockNativeEurPeriod}
            aria-describedby={lockNativeEurPeriod ? nativeEurPeriodDescriptionId : undefined}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm"
          />
        </label>

        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Periode von
          <input
            type="month"
            value={filters.periodFrom}
            onChange={(e) => onChange({ ...filters, periodFrom: e.target.value, periodFromDate: undefined, periodPreset: undefined })}
            disabled={lockNativeEurPeriod}
            aria-describedby={lockNativeEurPeriod ? nativeEurPeriodDescriptionId : undefined}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm"
          />
        </label>

        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Periode bis
          <input
            type="month"
            value={filters.periodTo}
            onChange={(e) => onChange({ ...filters, periodTo: e.target.value, periodToDate: undefined, periodPreset: undefined })}
            disabled={lockNativeEurPeriod}
            aria-describedby={lockNativeEurPeriod ? nativeEurPeriodDescriptionId : undefined}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm"
          />
        </label>

      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() =>
              lockNativeEurPeriod ? forceNativeEurPeriod() : onChange(defaultReportFilters(filters.chart, filters.businessReportingProfile))
            }
            className="h-7 px-2.5 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1 transition-colors"
          >
            <RotateCcw size={12} />
            Reset
          </button>
          {onExport && activeTab ? (
            <>
              <Button type="button" size="sm" variant="secondary" onClick={() => onExport('pdf')} disabled={exporting || Boolean(exportBlockedReason)}>
                <FileText size={13} aria-hidden="true" /> PDF
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => onExport('csv')} disabled={exporting || Boolean(exportBlockedReason)}>
                <FileDown size={13} aria-hidden="true" /> CSV
              </Button>
            </>
          ) : null}
        </div>
        {exportBlockedReason ? <p className="text-xs text-error" role="status">{exportBlockedReason}</p> : null}
      </div>
    </div>
  );
}
