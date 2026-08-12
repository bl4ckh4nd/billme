import { useEffect, useMemo, useState } from 'react';
import { FileBarChart2 } from 'lucide-react';
import { Button } from '@billme/ui';
import {
  BalanceSheetPreview,
  BalanceSheetPreviewLine,
  GuvLine,
  GuvReport,
  ReportDrilldownEntry,
  ReportDrilldownSelection,
  ReportExportRequest,
  ReportExportResult,
  ReportFilterState,
  ReportProfile,
  ReportTabId,
  reportTabsForProfile,
  SusaReport,
  SusaRow,
} from '../domain/reportTypes';
import {
  getBalanceSheetPreview,
  getBwaReport,
  getEurReport,
  getGuvReport,
  getHgbGuvReport,
  getReportDrilldownEntries,
  getManagementGuvReport,
  getSusaReport,
} from '../services/mockReportService';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';
import type { UserRole } from '../types';
import ReportToolbar from './reports/ReportToolbar';
import ReportTabSwitch from './reports/ReportTabSwitch';
import SusaTable from './reports/SusaTable';
import GuvView from './reports/GuvView';
import BalanceSheetPreviewView from './reports/BalanceSheetPreviewView';
import ReportDrilldownPanel from './reports/ReportDrilldownPanel';
import DatevExportPanel from './reports/DatevExportPanel';
import { reportDateRange } from '../domain/reportDates';
import ReportStatusBadge, { MappingHealthBlock, reportIsMappingBlocked } from './reports/ReportStatusBadge';

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
    periodPreset: 'current',
  };
}

interface ReportsViewProps {
  dataAdapter?: ProAccountingDataAdapter;
  chartFramework?: 'SKR03' | 'SKR04';
  profile?: ReportProfile;
  availableTabs?: ReportTabId[];
  role?: UserRole;
  onOpenTransaction?: (transactionId: string) => void;
  onOpenInvoice?: (invoiceId: string) => void;
  onOpenIncomingInvoice?: (invoiceId: string) => void;
  onOpenJournalEntry?: (journalEntryId: string) => void;
}

export default function ReportsView({ dataAdapter, chartFramework, profile = 'all', availableTabs, role = 'admin', onOpenTransaction, onOpenInvoice, onOpenIncomingInvoice, onOpenJournalEntry }: ReportsViewProps) {
  const visibleTabs = availableTabs ?? reportTabsForProfile(profile);
  const [activeTab, setActiveTab] = useState<ReportTabId>(() => visibleTabs.includes('susa') ? 'susa' : visibleTabs[0] ?? 'susa');
  const [filters, setFilters] = useState<ReportFilterState>(() => buildDefaultFilters(chartFramework));

  useEffect(() => {
    if (!chartFramework) return;
    setFilters((current) => (current.chart === chartFramework ? current : { ...current, chart: chartFramework }));
  }, [chartFramework]);
  const [susaReport, setSusaReport] = useState<SusaReport | null>(null);
  const [guvReport, setGuvReport] = useState<GuvReport | null>(null);
  const [balanceSheetPreview, setBalanceSheetPreview] = useState<BalanceSheetPreview | null>(null);
  const [eurReport, setEurReport] = useState<GuvReport | null>(null);
  const [bwaReport, setBwaReport] = useState<GuvReport | null>(null);
  const [managementGuvReport, setManagementGuvReport] = useState<GuvReport | null>(null);
  const [hgbGuvReport, setHgbGuvReport] = useState<GuvReport | null>(null);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reportsRetryKey, setReportsRetryKey] = useState(0);

  const [drilldownSelection, setDrilldownSelection] = useState<ReportDrilldownSelection | null>(null);
  const [drilldownEntries, setDrilldownEntries] = useState<ReportDrilldownEntry[]>([]);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState<string | null>(null);
  const [drilldownRetryKey, setDrilldownRetryKey] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) setActiveTab(visibleTabs[0] ?? 'susa');
  }, [activeTab, visibleTabs]);

  useEffect(() => {
    let cancelled = false;
    setReportsLoading(true);
    setReportsError(null);

    const load = <T,>(method: ((value: ReportFilterState) => Promise<T>) | undefined, fallback: (value: ReportFilterState) => Promise<T>) =>
      method ? method(filters) : fallback(filters);
    const loadReports = Promise.all([
      load(dataAdapter?.getSusaReport, getSusaReport),
      load(dataAdapter?.getGuvReport, getGuvReport),
      load(dataAdapter?.getBalanceSheetPreview, getBalanceSheetPreview),
      load(dataAdapter?.getEurReport, getEurReport),
      load(dataAdapter?.getBwaReport, getBwaReport),
      load(dataAdapter?.getManagementGuvReport, getManagementGuvReport),
      load(dataAdapter?.getHgbGuvReport, getHgbGuvReport),
    ]);

    loadReports
      .then(([susa, guv, bilanz, eur, bwa, management, hgb]) => {
        if (cancelled) return;
        setSusaReport(susa);
        setGuvReport(guv);
        setBalanceSheetPreview(bilanz);
        setEurReport(eur);
        setBwaReport(bwa);
        setManagementGuvReport(management);
        setHgbGuvReport(hgb);
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
  }, [dataAdapter, filters, reportsRetryKey]);

  useEffect(() => {
    if (!drilldownSelection) {
      setDrilldownEntries([]);
      setDrilldownError(null);
      return;
    }

    let cancelled = false;
    setDrilldownLoading(true);
    setDrilldownError(null);
    setDrilldownEntries([]);

    (dataAdapter
      ? dataAdapter.getReportDrilldownEntries
        ? dataAdapter.getReportDrilldownEntries(drilldownSelection)
        : Promise.reject(new Error('Drilldown ist für diesen Adapter nicht verfügbar.'))
      : getReportDrilldownEntries(drilldownSelection))
      .then((rows) => {
        if (!cancelled) setDrilldownEntries(rows);
      })
      .catch((error) => {
        if (!cancelled) setDrilldownError(error instanceof Error ? error.message : 'Drilldown konnte nicht geladen werden.');
      })
      .finally(() => {
        if (!cancelled) setDrilldownLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataAdapter, drilldownRetryKey, drilldownSelection]);

  const activeReportLabel = useMemo(() => ({
    eur: 'Einnahmenüberschussrechnung',
    susa: 'Summen- und Saldenliste',
    bwa01: 'BWA01',
    management_guv: 'Management-GuV',
    hgb_guv: 'Gewinn- und Verlustrechnung nach HGB',
    bilanz: 'Bilanz',
  })[activeTab], [activeTab]);
  const activeReport = activeTab === 'susa'
    ? susaReport
    : activeTab === 'bilanz'
      ? balanceSheetPreview
      : activeTab === 'eur'
        ? eurReport
        : activeTab === 'bwa01'
          ? bwaReport
          : activeTab === 'management_guv'
            ? managementGuvReport
            : hgbGuvReport;
  const activeQuality = activeReport?.quality;

  const exportReport = async (format: 'pdf' | 'csv') => {
    if (!dataAdapter) return;
    setExporting(true);
    setReportsError(null);
    const request: ReportExportRequest = { report: activeTab, filters, format };
    try {
      let result: ReportExportResult | void;
      if (dataAdapter.exportReport) result = await dataAdapter.exportReport(request);
      else if (format === 'pdf' && dataAdapter.exportReportPdf) result = await dataAdapter.exportReportPdf({ report: activeTab, filters });
      else if (format === 'csv' && dataAdapter.exportReportCsv) result = await dataAdapter.exportReportCsv({ report: activeTab, filters });
      else throw new Error('Report-Export ist für diesen Adapter nicht verfügbar.');
      setReportsError(result?.path ? `Export erstellt: ${result.path}` : `${format.toUpperCase()}-Export erstellt.`);
    } catch (error) {
      setReportsError(error instanceof Error ? error.message : 'Report-Export fehlgeschlagen.');
    } finally {
      setExporting(false);
    }
  };

  const handleSusaSelect = (row: SusaRow) => {
    const range = reportDateRange(filters);
    setDrilldownSelection({
      reportType: 'susa',
      targetId: row.accountNumber,
      targetLabel: `${row.accountNumber} · ${row.accountName}`,
      accountNumbers: [row.accountNumber],
      ...range,
    });
  };

  const handleGuvSelect = (line: GuvLine) => {
    const range = reportDateRange(filters);
    setDrilldownSelection({
      reportType: 'guv',
      targetId: line.id,
      targetLabel: `${line.code} · ${line.label}`,
      accountNumbers: line.accountRefs ?? [],
      ...range,
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
            <h1 className="text-sm font-black tracking-tight text-foreground">EÜR und Finanzberichte</h1>
            <p className="text-xs text-muted">Hierarchische Positionen mit Journal-Drilldown.</p>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <ReportToolbar filters={filters} onChange={setFilters} activeTab={activeTab} onExport={dataAdapter ? exportReport : undefined} exporting={exporting} />
        <div className="flex items-center justify-between gap-3">
          <ReportTabSwitch activeTab={activeTab} onChange={setActiveTab} tabs={visibleTabs} />
          <div className="text-xs text-muted flex items-center gap-2">
            Aktive Ansicht: {activeReportLabel}
            <ReportStatusBadge quality={activeQuality} />
          </div>
        </div>

        <div className="flex flex-col xl:flex-row gap-4">
            <div className="flex-1 min-w-0 pr-1">
              {reportsLoading ? (
                <div className="rounded-2xl border border-border bg-surface p-8 text-sm text-muted">
                  Lade Auswertungen…
                </div>
              ) : reportsError ? (
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-error-border bg-error-bg p-8 text-sm text-error" role="alert" aria-live="assertive">
                  <span>{reportsError}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setReportsRetryKey((current) => current + 1)}
                    disabled={reportsLoading}
                    aria-busy={reportsLoading}
                  >
                    {reportsLoading ? 'Lade erneut…' : 'Erneut versuchen'}
                  </Button>
                </div>
              ) : (
                <>
                  <MappingHealthBlock quality={activeQuality} />
                  {!activeQuality || reportIsMappingBlocked(activeQuality) ? null : activeTab === 'susa' ? (
                    <SusaTable report={susaReport} onSelectRow={handleSusaSelect} />
                  ) : activeTab === 'bilanz' ? (
                    <BalanceSheetPreviewView report={balanceSheetPreview} onSelectLine={handleBilanzSelect} />
                  ) : (
                    <GuvView report={activeReport as GuvReport | null} title={activeReportLabel} onSelectLine={handleGuvSelect} />
                  )}
                </>
              )}
            </div>

            <div className={`transition-all duration-200 ${drilldownSelection ? 'xl:w-96 w-full' : 'xl:w-0 w-full'}`}>
              {drilldownSelection ? (
                <div className="space-y-3">
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
                  {drilldownError ? (
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert" aria-live="assertive">
                      <span>{drilldownError}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setDrilldownRetryKey((current) => current + 1)}
                        disabled={drilldownLoading}
                        aria-busy={drilldownLoading}
                      >
                        {drilldownLoading ? 'Lade erneut…' : 'Drilldown erneut versuchen'}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="hidden xl:flex h-full items-center justify-center rounded-2xl border border-dashed border-border bg-surface/70 text-sm text-muted px-6 text-center">
                  Konto- oder Reportzeile anklicken, um Drilldown zu sehen.
                </div>
              )}
            </div>
        </div>
        <DatevExportPanel dataAdapter={dataAdapter} chartFramework={filters.chart} role={role} />
      </div>
    </div>
  );
}
