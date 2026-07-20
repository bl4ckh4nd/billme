import { Filter, RotateCcw } from 'lucide-react';
import { ReportFilterState } from '../../domain/reportTypes';

interface ReportToolbarProps {
  filters: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
}

export default function ReportToolbar({ filters, onChange }: ReportToolbarProps) {
  const set = <K extends keyof ReportFilterState>(key: K, value: ReportFilterState[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Chart
          <select
            value={filters.chart}
            onChange={(e) => set('chart', e.target.value as 'SKR03' | 'SKR04')}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm text-foreground"
          >
            <option value="SKR03">SKR03</option>
            <option value="SKR04">SKR04</option>
          </select>
        </label>

        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Mandant
          <select
            value={filters.mandantId}
            onChange={(e) => set('mandantId', e.target.value)}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm text-foreground"
          >
            <option value="demo-gmbh">Demo GmbH</option>
            <option value="holding-gmbh">Holding GmbH</option>
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

        <label className="text-[10px] font-bold uppercase tracking-wide text-muted">
          Vergleich
          <select
            value={filters.compareMode}
            onChange={(e) => set('compareMode', e.target.value as ReportFilterState['compareMode'])}
            className="mt-0.5 h-8 w-full rounded-lg border border-border px-2 text-sm text-foreground"
          >
            <option value="none">Kein Vergleich</option>
            <option value="prev_period">Vorperiode</option>
            <option value="prev_year">Vorjahr</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <input
            type="checkbox"
            checked={filters.includeDrafts}
            onChange={(e) => set('includeDrafts', e.target.checked)}
            className="rounded border-border"
          />
          Entwürfe einbeziehen (Preview)
        </label>
        <div className="flex gap-1.5">
          <button className="h-7 px-2.5 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1 transition-colors duration-150 ease-out">
            <Filter size={12} />
            Filter speichern (Mock)
          </button>
          <button
            onClick={() =>
              onChange({
                chart: 'SKR03',
                mandantId: 'demo-gmbh',
                asOfDate: new Date().toISOString().slice(0, 10),
                periodFrom: `${new Date().getFullYear()}-01`,
                periodTo: `${new Date().getFullYear()}-12`,
                compareMode: 'none',
                includeDrafts: false,
              })
            }
            className="h-7 px-2.5 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1 transition-colors duration-150 ease-out"
          >
            <RotateCcw size={12} />
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
