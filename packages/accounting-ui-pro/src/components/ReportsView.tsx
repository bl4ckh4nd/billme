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
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';
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
  dataAdapter?: ProAccountingDataAdapter;
  onOpenTransaction?: (transactionId: string) => void;
  onOpenReceipt?: (transactionId: string) => void;
}

export default function ReportsView({ dataAdapter, onOpenTransaction, onOpenReceipt }: ReportsViewProps) {
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
      (dataAdapter?.getSusaReport ?? getSusaReport)(filters),
      (dataAdapter?.getGuvReport ?? getGuvReport)(filters),
      (dataAdapter?.getBalanceSheetPreview ?? getBalanceSheetPreview)(filters),
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
  }, [dataAdapter, filters]);

  useEffect(() => {
    if (!drilldownSelection) {
      setDrilldownEntries([]);
      return;
    }

    let cancelled = false;
    setDrilldownLoading(true);

    (dataAdapter?.getReportDrilldownEntries ?? getReportDrilldownEntries)(drilldownSelection)
      .then((rows) => {
        if (!cancelled) setDrilldownEntries(rows);
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
    return 'Bilanz Preview';
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
      accountNumbers: BILANZ_ACCOUNT_MAP[line.id] ?? [line.code],
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-3 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-400 shrink-0">
            <span className="w-6 h-6 rounded-md bg-[#ccff00] text-black flex items-center justify-center">
              <FileBarChart2 size={13} />
            </span>
            Auswertungen
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-black tracking-tight text-gray-900">SuSa, GuV und Bilanz-Preview</h1>
            <p className="text-xs text-gray-400">SuSa, GuV und Bilanz mit Journal-Drilldown.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="px-3 h-8 rounded-full border border-gray-200 bg-white text-xs font-bold text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1.5 transition-colors">
              <Download size={13} /> Export (Mock)
            </button>
            <button className="px-3 h-8 rounded-full border border-gray-200 bg-white text-xs font-bold text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1.5 transition-colors">
              <RefreshCw size={13} /> Snapshot (Mock)
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <ReportToolbar filters={filters} onChange={setFilters} />
        <div className="flex items-center justify-between gap-3">
          <ReportTabSwitch activeTab={activeTab} onChange={setActiveTab} />
          <div className="text-xs text-gray-500 flex items-center gap-2">
            Aktive Ansicht: {activeReportLabel}
            {activeSource ? (
              <span
                className="rounded-full border border-gray-200 bg-white px-2 py-0.5 font-semibold uppercase tracking-wide"
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
                <div className="rounded-2xl border border-gray-200 bg-white p-8 text-sm text-gray-500">
                  Lade Auswertungen…
                </div>
              ) : reportsError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-sm text-red-700">
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

            <div className={`transition-all duration-200 ${drilldownSelection ? 'xl:w-[25rem] w-full' : 'xl:w-0 w-full'}`}>
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
                <div className="hidden xl:flex h-full items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-white/70 text-sm text-gray-400 px-6 text-center">
                  Konto- oder Reportzeile anklicken, um Drilldown zu sehen.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
  );
}
