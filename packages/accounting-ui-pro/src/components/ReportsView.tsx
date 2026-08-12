import { useEffect, useMemo, useState } from 'react';
import { FileBarChart2 } from 'lucide-react';
import {
  BalanceSheetPreview,
  BalanceSheetPreviewLine,
  GuvLine,
  GuvReport,
  ReportDrilldownEntry,
  ReportDrilldownSelection,
  ReportFilterState,
  SusaReport,
  SusaRow,
} from '../domain/reportTypes';
import {
  getBalanceSheetPreview,
  getGuvReport,
  getReportDrilldownEntries,
  getSusaReport,
} from '../services/mockReportService';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';
import ReportToolbar from './reports/ReportToolbar';
import ReportTabSwitch from './reports/ReportTabSwitch';
import SusaTable from './reports/SusaTable';
import GuvView from './reports/GuvView';
import BalanceSheetPreviewView from './reports/BalanceSheetPreviewView';
import ReportDrilldownPanel from './reports/ReportDrilldownPanel';
import DatevExportPanel from './reports/DatevExportPanel';

const BILANZ_ACCOUNT_MAP: Record<string, string[]> = {
  'a-1-1': ['0440', '0480'],
  'a-1-2': ['0670'],
  'a-2-1': ['1000', '1200'],
  'a-2-2': ['1576'],
  'p-1-2': ['9000', '4400', '4930'],
  'p-2-1': ['1600'],
  'p-2-2': ['1740', '1800'],
};

function buildDefaultFilters(chart: 'SKR03' | 'SKR04' = 'SKR03'): ReportFilterState {
  const now = new Date();
  return {
    chart,
    mandantId: 'demo-gmbh',
    asOfDate: now.toISOString().slice(0, 10),
    periodFrom: `${now.getFullYear()}-01`,
    periodTo: `${now.getFullYear()}-12`,
    compareMode: 'none',
    includeDrafts: false,
  };
}

interface ReportsViewProps {
  dataAdapter?: ProAccountingDataAdapter;
  chartFramework?: 'SKR03' | 'SKR04';
  onOpenTransaction?: (transactionId: string) => void;
  onOpenInvoice?: (invoiceId: string) => void;
  onOpenIncomingInvoice?: (invoiceId: string) => void;
  onOpenJournalEntry?: (journalEntryId: string) => void;
}

export default function ReportsView({ dataAdapter, chartFramework, onOpenTransaction, onOpenInvoice, onOpenIncomingInvoice, onOpenJournalEntry }: ReportsViewProps) {
  const [activeTab, setActiveTab] = useState<'susa' | 'guv' | 'bilanz'>('susa');
  const [filters, setFilters] = useState<ReportFilterState>(() => buildDefaultFilters(chartFramework));

  useEffect(() => {
    if (!chartFramework) return;
    setFilters((current) => (current.chart === chartFramework ? current : { ...current, chart: chartFramework }));
  }, [chartFramework]);
  const [susaReport, setSusaReport] = useState<SusaReport | null>(null);
  const [guvReport, setGuvReport] = useState<GuvReport | null>(null);
  const [balanceSheetPreview, setBalanceSheetPreview] = useState<BalanceSheetPreview | null>(null);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState<string | null>(null);

  const [drilldownSelection, setDrilldownSelection] = useState<ReportDrilldownSelection | null>(null);
  const [drilldownEntries, setDrilldownEntries] = useState<ReportDrilldownEntry[]>([]);
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReportsLoading(true);
    setReportsError(null);

    const loadReports = dataAdapter
      ? dataAdapter.getSusaReport && dataAdapter.getGuvReport && dataAdapter.getBalanceSheetPreview
        ? Promise.all([
            dataAdapter.getSusaReport(filters),
            dataAdapter.getGuvReport(filters),
            dataAdapter.getBalanceSheetPreview(filters),
          ])
        : Promise.reject(new Error('Auswertungen sind für diesen Adapter nicht verfügbar.'))
      : Promise.all([getSusaReport(filters), getGuvReport(filters), getBalanceSheetPreview(filters)]);

    loadReports
      .then(([susa, guv, bilanz]) => {
        if (cancelled) return;
        setSusaReport(susa);
        setGuvReport(guv);
        setBalanceSheetPreview(bilanz);
      })
      .catch((error) => {
        if (cancelled) return;
        setReportsError(error instanceof Error ? error.message : 'Auswertungen konnten nicht geladen werden.');
      })
      .finally(() => {
        if (!cancelled) setReportsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataAdapter, filters]);

  useEffect(() => {
    if (!drilldownSelection) {
      setDrilldownEntries([]);
      return;
    }

    let cancelled = false;
    setDrilldownLoading(true);

    (dataAdapter
      ? dataAdapter.getReportDrilldownEntries
        ? dataAdapter.getReportDrilldownEntries(drilldownSelection)
        : Promise.reject(new Error('Drilldown ist für diesen Adapter nicht verfügbar.'))
      : getReportDrilldownEntries(drilldownSelection))
      .then((rows) => {
        if (!cancelled) setDrilldownEntries(rows);
      })
      .catch((error) => {
        if (!cancelled) setReportsError(error instanceof Error ? error.message : 'Drilldown konnte nicht geladen werden.');
      })
      .finally(() => {
        if (!cancelled) setDrilldownLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataAdapter, drilldownSelection]);

  const activeReportLabel = useMemo(() => {
    if (activeTab === 'susa') return 'Summen- und Saldenliste';
    if (activeTab === 'guv') return 'Gewinn- und Verlustrechnung';
    return 'Bilanz';
  }, [activeTab]);
  const activeSource =
    activeTab === 'susa'
      ? susaReport?.quality.source
      : activeTab === 'guv'
        ? guvReport?.quality.source
      : balanceSheetPreview?.quality.source;

  const handleSusaSelect = (row: SusaRow) => {
    setDrilldownSelection({
      reportType: 'susa',
      targetId: row.accountNumber,
      targetLabel: `${row.accountNumber} · ${row.accountName}`,
      accountNumbers: [row.accountNumber],
      from: filters.periodFrom ? `${filters.periodFrom}-01` : undefined,
      to: filters.periodTo ? `${filters.periodTo}-31` : filters.asOfDate,
    });
  };

  const handleGuvSelect = (line: GuvLine) => {
    setDrilldownSelection({
      reportType: 'guv',
      targetId: line.id,
      targetLabel: `${line.code} · ${line.label}`,
      accountNumbers: line.accountRefs ?? [],
      from: filters.periodFrom ? `${filters.periodFrom}-01` : undefined,
      to: filters.periodTo ? `${filters.periodTo}-31` : filters.asOfDate,
    });
  };

  const handleBilanzSelect = (line: BalanceSheetPreviewLine) => {
    setDrilldownSelection({
      reportType: 'bilanz',
      targetId: line.id,
      targetLabel: `${line.code} · ${line.label}`,
      accountNumbers: BILANZ_ACCOUNT_MAP[line.id] ?? [line.code],
      to: filters.asOfDate,
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-3 border-b border-subtle shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted shrink-0">
            <span className="w-6 h-6 rounded-md bg-accent text-foreground flex items-center justify-center">
              <FileBarChart2 size={13} />
            </span>
            Auswertungen
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-black tracking-tight text-foreground">SuSa, GuV und Bilanz</h1>
            <p className="text-xs text-muted">SuSa, GuV und Bilanz mit Journal-Drilldown.</p>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <ReportToolbar filters={filters} onChange={setFilters} />
        <div className="flex items-center justify-between gap-3">
          <ReportTabSwitch activeTab={activeTab} onChange={setActiveTab} />
          <div className="text-xs text-muted flex items-center gap-2">
            Aktive Ansicht: {activeReportLabel}
            {activeSource ? (
              <span
                className="rounded-full border border-border bg-surface px-2 py-0.5 font-semibold uppercase tracking-wide"
                title={
                  activeSource === 'live'
                    ? 'Auswertung aus den gebuchten Daten dieser Installation.'
                    : 'Beispieldaten zur Ansicht — nicht aus Ihrer Buchhaltung.'
                }
              >
                {activeSource === 'live' ? 'Live-Daten' : 'Beispieldaten'}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col xl:flex-row gap-4">
            <div className="flex-1 min-w-0 pr-1">
              {reportsLoading ? (
                <div className="rounded-2xl border border-border bg-surface p-8 text-sm text-muted">
                  Lade Auswertungen…
                </div>
              ) : reportsError ? (
                <div className="rounded-2xl border border-error-border bg-error-bg p-8 text-sm text-error" role="alert" aria-live="assertive">
                  {reportsError}
                </div>
              ) : activeTab === 'susa' ? (
                <SusaTable report={susaReport} onSelectRow={handleSusaSelect} />
              ) : activeTab === 'guv' ? (
                <GuvView report={guvReport} onSelectLine={handleGuvSelect} />
              ) : (
                <BalanceSheetPreviewView report={balanceSheetPreview} onSelectLine={handleBilanzSelect} />
              )}
            </div>

            <div className={`transition-all duration-200 ${drilldownSelection ? 'xl:w-96 w-full' : 'xl:w-0 w-full'}`}>
              {drilldownSelection ? (
                <ReportDrilldownPanel
                  selection={drilldownSelection}
                  entries={drilldownEntries}
                  loading={drilldownLoading}
                  onClose={() => setDrilldownSelection(null)}
                  onOpenTransaction={onOpenTransaction}
                  onOpenInvoice={onOpenInvoice}
                  onOpenIncomingInvoice={onOpenIncomingInvoice}
                  onOpenJournalEntry={onOpenJournalEntry}
                />
              ) : (
                <div className="hidden xl:flex h-full items-center justify-center rounded-2xl border border-dashed border-border bg-surface/70 text-sm text-muted px-6 text-center">
                  Konto- oder Reportzeile anklicken, um Drilldown zu sehen.
                </div>
              )}
            </div>
        </div>
        <DatevExportPanel dataAdapter={dataAdapter} chartFramework={filters.chart} />
      </div>
    </div>
  );
}
