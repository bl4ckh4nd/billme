import { FileDown, FileText, RotateCcw } from 'lucide-react';
import { Button } from '@billme/ui';
import { ReportFilterState, ReportTabId } from '../../domain/reportTypes';

interface ReportToolbarProps {
  filters: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
  activeTab?: ReportTabId;
  onExport?: (format: 'pdf' | 'csv') => void;
  exporting?: boolean;
}

export default function ReportToolbar({ filters, onChange, activeTab, onExport, exporting = false }: ReportToolbarProps) {
  const set = <K extends keyof ReportFilterState>(key: K, value: ReportFilterState[K]) =>
    onChange({ ...filters, [key]: value });
  const setPreset = (periodPreset: ReportFilterState['periodPreset']) => {
    const year = Number(filters.asOfDate.slice(0, 4));
    const month = filters.asOfDate.slice(5, 7);
    const currentMonth = `${year}-${month}`;
    if (periodPreset === 'ytd') onChange({ ...filters, periodPreset, periodFrom: `${year}-01`, periodTo: currentMonth, compareMode: 'none' });
    else if (periodPreset === 'prev_year') onChange({ ...filters, periodPreset, periodFrom: `${year - 1}-01`, periodTo: `${year - 1}-12`, compareMode: 'prev_year' });
    else onChange({ ...filters, periodPreset: 'current', periodFrom: currentMonth, periodTo: currentMonth, compareMode: 'none' });
  };

  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Zeitraum
          <select
            aria-label="Zeitraum"
            value={filters.periodPreset ?? 'current'}
            onChange={(event) => setPreset(event.target.value as ReportFilterState['periodPreset'])}
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
            onChange={(e) => set('asOfDate', e.target.value)}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm"
          />
        </label>

        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Periode von
          <input
            type="month"
            value={filters.periodFrom}
            onChange={(e) => set('periodFrom', e.target.value)}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm"
          />
        </label>

        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Periode bis
          <input
            type="month"
            value={filters.periodTo}
            onChange={(e) => set('periodTo', e.target.value)}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm"
          />
        </label>

      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() =>
              onChange({
                chart: filters.chart,
                mandantId: 'demo-gmbh',
                asOfDate: new Date().toISOString().slice(0, 10),
                periodFrom: `${new Date().getFullYear()}-01`,
                periodTo: `${new Date().getFullYear()}-12`,
                compareMode: 'none',
                includeDrafts: false,
                periodPreset: 'current',
              })
            }
            className="h-7 px-2.5 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1 transition-colors"
          >
            <RotateCcw size={12} />
            Reset
          </button>
          {onExport && activeTab ? (
            <>
              <Button type="button" size="sm" variant="secondary" onClick={() => onExport('pdf')} disabled={exporting}>
                <FileText size={13} aria-hidden="true" /> PDF
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => onExport('csv')} disabled={exporting}>
                <FileDown size={13} aria-hidden="true" /> CSV
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
