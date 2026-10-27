import { FileDown, FileText, RotateCcw } from 'lucide-react';
import { Button, Input, Select } from '@billme/ui';
import { ReportFilterState, ReportTabId } from '../../domain/reportTypes';
import { defaultReportFilters, nativeEurRange, reportPeriodRangeForPreset } from '../../domain/reportDates';

interface ReportToolbarProps {
  filters: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
  activeTab?: ReportTabId;
  onExport?: (format: 'pdf' | 'csv') => void;
  exporting?: boolean;
  exportBlockedReason?: string;
  hideExportBlockedReason?: boolean;
  /** Native EÜR is currently a fixed, print-only 2025 report. */
  lockNativeEurPeriod?: boolean;
  nativeEurTaxYear?: number;
}

export default function ReportToolbar({ filters, onChange, activeTab, onExport, exporting = false, exportBlockedReason, hideExportBlockedReason = false, lockNativeEurPeriod = false, nativeEurTaxYear = 2025 }: ReportToolbarProps) {
  const nativeEurPeriodDescriptionId = 'native-eur-period-description';
  const forceNativeEurPeriod = () => onChange({
    ...filters,
    asOfDate: nativeEurRange(nativeEurTaxYear).to,
    periodFrom: nativeEurRange(nativeEurTaxYear).from.slice(0, 7),
    periodTo: nativeEurRange(nativeEurTaxYear).to.slice(0, 7),
    periodFromDate: nativeEurRange(nativeEurTaxYear).from,
    periodToDate: nativeEurRange(nativeEurTaxYear).to,
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
      // The comparison is its own choice: switching the period keeps it.
      compareMode: filters.compareMode,
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
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label="Zeitraum"
          value={filters.periodPreset ?? 'custom'}
          onChange={(event) => { if (event.target.value !== 'custom') setPreset(event.target.value as ReportFilterState['periodPreset']); }}
          disabled={lockNativeEurPeriod}
          aria-describedby={lockNativeEurPeriod ? nativeEurPeriodDescriptionId : undefined}
        >
          <option value="current">Aktuelle Periode</option>
          <option value="ytd">Jahr bis heute</option>
          <option value="prev_year">Vorjahr</option>
          {/* A range typed into "Periode von/bis" or opened from the overview has no preset. */}
          {filters.periodPreset ? null : <option value="custom">Eigener Zeitraum</option>}
        </Select>
        <Input
          label="Stichtag"
          type="date"
          value={filters.asOfDate}
          onChange={(e) => setAsOfDate(e.target.value)}
          disabled={lockNativeEurPeriod}
          aria-describedby={lockNativeEurPeriod ? nativeEurPeriodDescriptionId : undefined}
        />
        <Input
          label="Periode von"
          type="month"
          value={filters.periodFrom}
          onChange={(e) => onChange({ ...filters, periodFrom: e.target.value, periodFromDate: undefined, periodPreset: undefined })}
          disabled={lockNativeEurPeriod}
          aria-describedby={lockNativeEurPeriod ? nativeEurPeriodDescriptionId : undefined}
        />
        <Input
          label="Periode bis"
          type="month"
          value={filters.periodTo}
          onChange={(e) => onChange({ ...filters, periodTo: e.target.value, periodToDate: undefined, periodPreset: undefined })}
          disabled={lockNativeEurPeriod}
          aria-describedby={lockNativeEurPeriod ? nativeEurPeriodDescriptionId : undefined}
        />
        {activeTab === 'bwa01' || activeTab === 'management_guv' || activeTab === 'hgb_guv' ? (
          <Select
            label="Vergleich"
            value={filters.compareMode === 'prev_year' ? 'prev_year' : 'none'}
            onChange={(event) => onChange({ ...filters, compareMode: event.target.value === 'prev_year' ? 'prev_year' : 'none' })}
          >
            <option value="none">Ohne Vergleich</option>
            <option value="prev_year">Vorjahr</option>
          </Select>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              lockNativeEurPeriod ? forceNativeEurPeriod() : onChange(defaultReportFilters(filters.chart, filters.businessReportingProfile))
            }
          >
            <RotateCcw size={14} aria-hidden="true" />
            Reset
          </Button>
          {onExport && activeTab ? (
            <>
              <Button type="button" variant="secondary" onClick={() => onExport('pdf')} disabled={exporting || Boolean(exportBlockedReason)}>
                <FileText size={14} aria-hidden="true" /> PDF
              </Button>
              <Button type="button" variant="secondary" onClick={() => onExport('csv')} disabled={exporting || Boolean(exportBlockedReason)}>
                <FileDown size={14} aria-hidden="true" /> CSV
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {lockNativeEurPeriod ? (
        <p id={nativeEurPeriodDescriptionId} className="text-caption text-muted" role="status">
          {nativeEurTaxYear === 2025 ? 'Die native EÜR ist derzeit nur für das Druckformular 2025 verfügbar. Der Zeitraum ist deshalb fest auf 01.01.2025–31.12.2025 eingestellt.' : `Die native EÜR ist für das Katalogjahr ${nativeEurTaxYear} verfügbar. Der Zeitraum ist deshalb fest auf 01.01.${nativeEurTaxYear}–31.12.${nativeEurTaxYear} eingestellt.`}
        </p>
      ) : null}
      {exportBlockedReason && !hideExportBlockedReason ? <p className="text-caption text-error-text" role="status">{exportBlockedReason}</p> : null}
    </div>
  );
}
