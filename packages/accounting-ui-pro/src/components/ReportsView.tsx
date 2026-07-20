import { useEffect, useMemo, useState } from 'react';
import { Download, FileBarChart2, RefreshCw } from 'lucide-react';
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
import ReportToolbar from './reports/ReportToolbar';
import ReportTabSwitch from './reports/ReportTabSwitch';
import SusaTable from './reports/SusaTable';
import GuvView from './reports/GuvView';
import BalanceSheetPreviewView from './reports/BalanceSheetPreviewView';
import ReportDrilldownPanel from './reports/ReportDrilldownPanel';

const BILANZ_ACCOUNT_MAP: Record<string, string[]> = {
  'a-1-1': ['0440', '0480'],
  'a-1-2': ['0670'],
  'a-2-1': ['1000', '1200'],
  'a-2-2': ['1576'],
  'p-1-2': ['9000', '4400', '4930'],
  'p-2-1': ['1600'],
  'p-2-2': ['1740', '1800'],
};

function buildDefaultFilters(): ReportFilterState {
  const now = new Date();
  return {
    chart: 'SKR03',
    mandantId: 'demo-gmbh',
    asOfDate: now.toISOString().slice(0, 10),
    periodFrom: `${now.getFullYear()}-01`,
    periodTo: `${now.getFullYear()}-12`,
    compareMode: 'none',
    includeDrafts: false,
  };
}

interface ReportsViewProps {
  onOpenTransaction?: (transactionId: string) => void;
  onOpenReceipt?: (transactionId: string) => void;
}

export default function ReportsView({ onOpenTransaction, onOpenReceipt }: ReportsViewProps) {
  const [activeTab, setActiveTab] = useState<'susa' | 'guv' | 'bilanz'>('susa');
  const [filters, setFilters] = useState<ReportFilterState>(() => buildDefaultFilters());
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

    Promise.all([
      getSusaReport(filters),
      getGuvReport(filters),
      getBalanceSheetPreview(filters),
    ])
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
  }, [filters]);

  useEffect(() => {
    if (!drilldownSelection) {
      setDrilldownEntries([]);
      return;
    }

    let cancelled = false;
    setDrilldownLoading(true);

    getReportDrilldownEntries(drilldownSelection)
      .then((rows) => {
        if (!cancelled) setDrilldownEntries(rows);
      })
      .finally(() => {
        if (!cancelled) setDrilldownLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [drilldownSelection]);

  const activeReportLabel = useMemo(() => {
    if (activeTab === 'susa') return 'Summen- und Saldenliste';
    if (activeTab === 'guv') return 'Gewinn- und Verlustrechnung';
    return 'Bilanz Preview';
  }, [activeTab]);

  const handleSusaSelect = (row: SusaRow) => {
    setDrilldownSelection({
      reportType: 'susa',
      targetId: row.accountNumber,
      targetLabel: `${row.accountNumber} · ${row.accountName}`,
      accountNumbers: [row.accountNumber],
    });
  };

  const handleGuvSelect = (line: GuvLine) => {
    setDrilldownSelection({
      reportType: 'guv',
      targetId: line.id,
      targetLabel: `${line.code} · ${line.label}`,
      accountNumbers: line.accountRefs ?? [],
    });
  };

  const handleBilanzSelect = (line: BalanceSheetPreviewLine) => {
    setDrilldownSelection({
      reportType: 'bilanz',
      targetId: line.id,
      targetLabel: `${line.code} · ${line.label}`,
      accountNumbers: BILANZ_ACCOUNT_MAP[line.id] ?? [],
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-3 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted shrink-0">
            <span className="w-6 h-6 rounded-md bg-accent-lime text-foreground flex items-center justify-center">
              <FileBarChart2 size={13} />
            </span>
            Auswertungen
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-black tracking-tight text-foreground">SuSa, GuV und Bilanz-Preview</h1>
            <p className="text-xs text-muted">
              Prototypische Reporting-UI mit Drilldown-Struktur, vorbereitet für spätere SQLite-/Ledger-Anbindung.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="px-3 h-8 rounded-full border border-border bg-surface text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1.5 transition-colors duration-150 ease-out">
              <Download size={13} /> Export (Mock)
            </button>
            <button className="px-3 h-8 rounded-full border border-border bg-surface text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1.5 transition-colors duration-150 ease-out">
              <RefreshCw size={13} /> Snapshot (Mock)
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <ReportToolbar filters={filters} onChange={setFilters} />
        <div className="flex items-center justify-between gap-3">
          <ReportTabSwitch activeTab={activeTab} onChange={setActiveTab} />
          <div className="text-xs text-muted hidden md:block">Aktive Ansicht: {activeReportLabel}</div>
        </div>

        <div className="flex flex-col xl:flex-row gap-4">
            <div className="flex-1 min-w-0 pr-1">
              {reportsLoading ? (
                <div className="rounded-xl border border-border bg-surface p-8 text-sm text-muted">
                  Lade Auswertungen…
                </div>
              ) : reportsError ? (
                <div className="rounded-xl border border-error-border bg-error-bg p-8 text-sm text-error">
                  {reportsError}
                </div>
              ) : activeTab === 'susa' ? (
                <SusaTable report={susaReport} onSelectRow={handleSusaSelect} />
              ) : activeTab === 'guv' ? (
                <GuvView report={guvReport} compareMode={filters.compareMode} onSelectLine={handleGuvSelect} />
              ) : (
                <BalanceSheetPreviewView report={balanceSheetPreview} onSelectLine={handleBilanzSelect} />
              )}
            </div>

            <div className={`transition-colors duration-200 ${drilldownSelection ? 'xl:w-[25rem] w-full' : 'xl:w-0 w-full'}`}>
              {drilldownSelection ? (
                <ReportDrilldownPanel
                  selection={drilldownSelection}
                  entries={drilldownEntries}
                  loading={drilldownLoading}
                  onClose={() => setDrilldownSelection(null)}
                  onOpenJournalEntry={onOpenTransaction}
                  onOpenReceipt={onOpenReceipt}
                />
              ) : (
                <div className="hidden xl:flex h-full items-center justify-center rounded-xl border border-dashed border-border bg-surface/70 text-sm text-muted px-6 text-center">
                  Konto- oder Reportzeile anklicken, um Drilldown zu sehen.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
  );
}
