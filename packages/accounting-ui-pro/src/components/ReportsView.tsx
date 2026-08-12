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
  BusinessReportingProfile,
  EurCashItem,
  reportTabsForProfile,
  reportTabsForBusinessProfile,
  SusaReport,
  SusaRow,
} from '../domain/reportTypes';
import {
  getBalanceSheetPreview,
  getBwaReport,
  getEurReport,
  getHgbGuvReport,
  getReportDrilldownEntries,
  getManagementGuvReport,
  getSusaReport,
} from '../services/mockReportService';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';
import type { UserRole } from '../types';
import { permissionContextForRole } from '../mocks/users';
import ReportToolbar from './reports/ReportToolbar';
import ReportTabSwitch from './reports/ReportTabSwitch';
import SusaTable from './reports/SusaTable';
import GuvView from './reports/GuvView';
import BalanceSheetPreviewView from './reports/BalanceSheetPreviewView';
import ReportDrilldownPanel from './reports/ReportDrilldownPanel';
import DatevExportPanel from './reports/DatevExportPanel';
import { defaultReportFilters, reportDateRange, reportFiscalYearRange } from '../domain/reportDates';
import ReportStatusBadge, { MappingHealthBlock, reportIsMappingBlocked } from './reports/ReportStatusBadge';
import ReportMappingSetup from './reports/ReportMappingSetup';
import type { ReportMappingStatement } from '../domain/reportMapping';

type EurClassificationDraft = {
  eurLineId?: string;
  excluded: boolean;
  vatMode: 'none' | 'default';
  vatRate?: number;
  note?: string;
};

const eurCashItemKey = (item: EurCashItem): string => `${item.sourceType}:${item.sourceId}`;

const eurDraftFor = (item: EurCashItem): EurClassificationDraft => ({
  eurLineId: item.classification?.eurLineId,
  excluded: item.classification?.excluded ?? false,
  vatMode: item.classification?.vatMode ?? 'none',
  vatRate: item.classification?.vatRate,
  note: item.classification?.note,
});

interface ReportsViewProps {
  dataAdapter?: ProAccountingDataAdapter;
  chartFramework?: 'SKR03' | 'SKR04';
  businessReportingProfile?: BusinessReportingProfile;
  profile?: ReportProfile;
  availableTabs?: ReportTabId[];
  role?: UserRole;
  onOpenTransaction?: (transactionId: string) => void;
  onOpenInvoice?: (invoiceId: string) => void;
  onOpenIncomingInvoice?: (invoiceId: string) => void;
  onOpenJournalEntry?: (journalEntryId: string) => void;
}

const hasEurFilingProvenance = (report: unknown): boolean => {
  if (!report || typeof report !== 'object') return false;
  const filing = (report as { filing?: unknown }).filing;
  if (!filing || typeof filing !== 'object') return false;
  const value = filing as { kind?: unknown; taxYear?: unknown; catalog?: unknown; lineProvenance?: unknown };
  if (value.kind !== 'euer' || value.taxYear !== 2025 || !Array.isArray(value.lineProvenance) || value.lineProvenance.length === 0) return false;
  const catalog = value.catalog;
  if (!catalog || typeof catalog !== 'object') return false;
  const sourceHash = (catalog as { sourceHash?: unknown }).sourceHash;
  return typeof sourceHash === 'string' && /^[a-f0-9]{64}$/i.test(sourceHash)
    && value.lineProvenance.every((line) => {
      if (!line || typeof line !== 'object') return false;
      const row = line as { lineId?: unknown; exportable?: unknown; kennziffer?: unknown; providerPath?: unknown };
      return typeof row.lineId === 'string'
        && typeof row.exportable === 'boolean'
        && (!row.exportable || (typeof row.kennziffer === 'string' && typeof row.providerPath === 'string'));
    });
};

export default function ReportsView({ dataAdapter, chartFramework, businessReportingProfile, profile = 'all', availableTabs, role = 'admin', onOpenTransaction, onOpenInvoice, onOpenIncomingInvoice, onOpenJournalEntry }: ReportsViewProps) {
  const visibleTabs = useMemo(() => {
    if (availableTabs) return availableTabs;
    if (businessReportingProfile) return reportTabsForBusinessProfile(businessReportingProfile);
    if (profile !== 'all') return reportTabsForProfile(profile);
    return ['susa'] as ReportTabId[];
  }, [availableTabs, businessReportingProfile, profile]);
  const [activeTab, setActiveTab] = useState<ReportTabId>(() => visibleTabs.includes('susa') ? 'susa' : visibleTabs[0] ?? 'susa');
  const [filters, setFilters] = useState<ReportFilterState>(() => defaultReportFilters(chartFramework ?? businessReportingProfile?.chart, businessReportingProfile));

  useEffect(() => {
    if (!chartFramework && !businessReportingProfile) return;
    setFilters((current) => {
      const profileChanged = current.businessReportingProfile?.legalForm !== businessReportingProfile?.legalForm
        || current.businessReportingProfile?.profitDetermination !== businessReportingProfile?.profitDetermination
        || current.businessReportingProfile?.fiscalYearStart !== businessReportingProfile?.fiscalYearStart
        || current.businessReportingProfile?.chart !== businessReportingProfile?.chart;
      if ((!chartFramework || current.chart === chartFramework) && !profileChanged) return current;
      return defaultReportFilters(chartFramework ?? businessReportingProfile?.chart ?? current.chart, businessReportingProfile, current.asOfDate);
    });
  }, [businessReportingProfile?.chart, businessReportingProfile?.fiscalYearStart, businessReportingProfile?.legalForm, businessReportingProfile?.profitDetermination, chartFramework]);
  const [susaReport, setSusaReport] = useState<SusaReport | null>(null);
  const [balanceSheetPreview, setBalanceSheetPreview] = useState<BalanceSheetPreview | null>(null);
  const [eurReport, setEurReport] = useState<GuvReport | null>(null);
  const [bwaReport, setBwaReport] = useState<GuvReport | null>(null);
  const [managementGuvReport, setManagementGuvReport] = useState<GuvReport | null>(null);
  const [hgbGuvReport, setHgbGuvReport] = useState<GuvReport | null>(null);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reportsNotice, setReportsNotice] = useState<string | null>(null);
  const [reportsRetryKey, setReportsRetryKey] = useState(0);
  const [eurItems, setEurItems] = useState<EurCashItem[]>([]);
  const [eurItemsLoading, setEurItemsLoading] = useState(false);
  const [eurItemsError, setEurItemsError] = useState<string | null>(null);
  const [eurDrafts, setEurDrafts] = useState<Record<string, EurClassificationDraft>>({});
  const [eurClassificationReason, setEurClassificationReason] = useState('');
  const [eurClassifying, setEurClassifying] = useState<string | null>(null);

  const [drilldownSelection, setDrilldownSelection] = useState<ReportDrilldownSelection | null>(null);
  const [drilldownEntries, setDrilldownEntries] = useState<ReportDrilldownEntry[]>([]);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState<string | null>(null);
  const [drilldownRetryKey, setDrilldownRetryKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [freezeReason, setFreezeReason] = useState('');
  const canMutate = permissionContextForRole(role).canMutate;

  const profileSetupError = businessReportingProfile
    && businessReportingProfile.legalForm === 'gmbh'
    && businessReportingProfile.profitDetermination === 'double_entry'
    && !reportFiscalYearRange(filters.asOfDate, businessReportingProfile)
    ? 'Der Wirtschaftsjahresbeginn ist nicht eingerichtet. Bitte hinterlegen Sie in den Einstellungen ein gültiges Datum (MM-TT), bevor Sie Berichte öffnen.'
    : null;

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) setActiveTab(visibleTabs[0] ?? 'susa');
  }, [activeTab, visibleTabs]);

  useEffect(() => {
    let cancelled = false;
    setReportsLoading(true);
    setReportsError(null);
    setReportsNotice(null);

    if (profileSetupError) {
      setReportsError(profileSetupError);
      setReportsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const missingReportMethod = <T,>(tab: ReportTabId): Promise<T> => Promise.reject(new Error(
      `${tab === 'bwa01' ? 'BWA01' : tab === 'management_guv' ? 'Management-GuV' : tab === 'hgb_guv' ? 'HGB-GuV' : tab === 'bilanz' ? 'Bilanz' : tab === 'eur' ? 'EÜR' : 'SuSa'} ist für diese Verbindung nicht verfügbar. Bitte Reporting-Profil und Adapter-Konfiguration prüfen.`,
    ));
    const load = <T,>(tab: ReportTabId, method: ((value: ReportFilterState) => Promise<T>) | undefined, fallback: (value: ReportFilterState) => Promise<T>) => {
      if (!dataAdapter) return fallback(filters);
      return method ? method(filters) : missingReportMethod<T>(tab);
    };
    const loadReports = Promise.all([
      visibleTabs.includes('susa') ? load('susa', dataAdapter?.getSusaReport, getSusaReport) : Promise.resolve(null),
      visibleTabs.includes('bilanz') ? load('bilanz', dataAdapter?.getBalanceSheetPreview, getBalanceSheetPreview) : Promise.resolve(null),
      visibleTabs.includes('eur') ? load('eur', dataAdapter?.getEurReport, getEurReport) : Promise.resolve(null),
      visibleTabs.includes('bwa01') ? load('bwa01', dataAdapter?.getBwaReport, getBwaReport) : Promise.resolve(null),
      visibleTabs.includes('management_guv') ? load('management_guv', dataAdapter?.getManagementGuvReport, getManagementGuvReport) : Promise.resolve(null),
      visibleTabs.includes('hgb_guv') ? load('hgb_guv', dataAdapter?.getHgbGuvReport, getHgbGuvReport) : Promise.resolve(null),
    ]);

    loadReports
      .then(([susa, bilanz, eur, bwa, management, hgb]) => {
        if (cancelled) return;
        setSusaReport(susa);
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
  }, [dataAdapter, filters, profileSetupError, reportsRetryKey, visibleTabs]);

  useEffect(() => {
    if (!visibleTabs.includes('eur') || !dataAdapter?.listEurCashItems) {
      setEurItems([]);
      setEurItemsError(null);
      setEurItemsLoading(false);
      return;
    }
    let cancelled = false;
    setEurItemsLoading(true);
    setEurItemsError(null);
    dataAdapter.listEurCashItems()
      .then((items) => {
        if (cancelled) return;
        setEurItems(items);
        setEurDrafts((current) => {
          const next = { ...current };
          for (const item of items) {
            const key = eurCashItemKey(item);
            if (!next[key]) next[key] = eurDraftFor(item);
          }
          return next;
        });
      })
      .catch((error) => {
        if (!cancelled) setEurItemsError(error instanceof Error ? error.message : 'EÜR-Quellen konnten nicht geladen werden.');
      })
      .finally(() => {
        if (!cancelled) setEurItemsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataAdapter, reportsRetryKey, visibleTabs]);

  useEffect(() => {
    if (!drilldownSelection) {
      setDrilldownEntries([]);
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
  const mappingStatements = useMemo<ReportMappingStatement[]>(() => [
    ...(visibleTabs.includes('bwa01') ? ['bwa01' as const] : []),
    ...(visibleTabs.includes('management_guv') ? ['management-guv' as const] : []),
    ...(visibleTabs.includes('hgb_guv') ? ['hgb-guv' as const] : []),
    ...(visibleTabs.includes('bilanz') ? ['hgb-bilanz' as const] : []),
  ], [visibleTabs]);
  const mappingAsOfDate = reportDateRange(filters).to ?? filters.asOfDate;
  const activeQualityBlocksFreeze = activeTab === 'eur' && Boolean(activeQuality && (
    reportIsMappingBlocked(activeQuality)
    || ('warnings' in activeQuality && typeof activeQuality.warnings === 'number' && activeQuality.warnings > 0)
    || ('source' in activeQuality && activeQuality.source !== 'live')
    || !hasEurFilingProvenance(activeReport)
  ));

  const saveEurClassification = async (item: EurCashItem) => {
    if (!dataAdapter?.upsertEurClassification) return;
    const reason = eurClassificationReason.trim();
    if (!reason) {
      setReportsNotice(null);
      setReportsError('Bitte geben Sie einen Audit-Grund für die EÜR-Klassifikation an.');
      return;
    }
    const key = eurCashItemKey(item);
    const draft = eurDrafts[key] ?? eurDraftFor(item);
    setEurClassifying(key);
    setReportsError(null);
    setReportsNotice(null);
    try {
      await dataAdapter.upsertEurClassification({
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        taxYear: 2025,
        eurLineId: draft.eurLineId,
        excluded: draft.excluded,
        vatMode: draft.vatMode,
        vatRate: draft.vatRate,
        note: draft.note,
        reason,
      });
      setReportsNotice('EÜR-Klassifikation gespeichert und im Audit protokolliert.');
      setReportsRetryKey((current) => current + 1);
    } catch (error) {
      setReportsError(error instanceof Error ? error.message : 'EÜR-Klassifikation konnte nicht gespeichert werden.');
    } finally {
      setEurClassifying(null);
    }
  };

  const eurLines = useMemo(
    () => (eurReport?.lines ?? []).filter((line) => !line.isSubtotal),
    [eurReport?.lines],
  );

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
      setReportsError(null);
      setReportsNotice(result?.path ? `Export erstellt: ${result.path}` : `${format.toUpperCase()}-Export erstellt.`);
    } catch (error) {
      setReportsNotice(null);
      setReportsError(error instanceof Error ? error.message : 'Report-Export fehlgeschlagen.');
    } finally {
      setExporting(false);
    }
  };

  const freezeCurrentReport = async () => {
    if (!canMutate || !dataAdapter?.saveReportSnapshot || !activeReport || activeTab !== 'eur' || activeQualityBlocksFreeze) return;
    const range = reportDateRange(filters);
    if (range.from !== '2025-01-01' || range.to !== '2025-12-31') {
      setReportsNotice(null);
      setReportsError('Für das Filing-Center kann nur ein vollständiger EÜR-2025-Zeitraum eingefroren werden.');
      return;
    }
    const reason = freezeReason.trim();
    if (!reason) {
      setReportsNotice(null);
      setReportsError('Bitte geben Sie einen Audit-Grund für das Einfrieren des EÜR-Snapshots an.');
      return;
    }
    setFreezing(true);
    setReportsError(null);
    setReportsNotice(null);
    try {
      await dataAdapter.saveReportSnapshot({
        reportType: activeTab,
        args: filters,
        payload: activeReport,
        reason,
      });
      setFreezeReason('');
      setReportsNotice('EÜR-Snapshot eingefroren und im Audit protokolliert.');
    } catch (error) {
      setReportsNotice(null);
      setReportsError(error instanceof Error ? error.message : 'Snapshot konnte nicht eingefroren werden.');
    } finally {
      setFreezing(false);
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
    if (!line.accountRefs?.length) {
      setDrilldownSelection(null);
      setDrilldownEntries([]);
      setDrilldownError('Für diese Bilanzposition ist kein Konten-Mapping verfügbar. Bitte richten Sie das Mapping ein, bevor Sie den Drilldown öffnen.');
      return;
    }
    setDrilldownError(null);
    setDrilldownSelection({
      reportType: 'bilanz',
      targetId: line.id,
      targetLabel: `${line.code} · ${line.label}`,
      accountNumbers: line.accountRefs,
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
        <ReportMappingSetup
          dataAdapter={dataAdapter}
          chart={filters.chart}
          role={role}
          statements={mappingStatements}
          asOfDate={mappingAsOfDate}
          refreshKey={reportsRetryKey}
          onMappingChanged={() => setReportsRetryKey((current) => current + 1)}
        />
        <ReportToolbar
          filters={filters}
          onChange={setFilters}
          activeTab={activeTab}
          onExport={dataAdapter ? exportReport : undefined}
          exporting={exporting}
        />
        {activeTab === 'eur' && dataAdapter?.saveReportSnapshot ? canMutate ? (
          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3">
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-semibold text-foreground" htmlFor="report-freeze-reason">
              Audit-Grund für EÜR-Snapshot
              <input
                id="report-freeze-reason"
                className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-normal"
                value={freezeReason}
                onChange={(event) => setFreezeReason(event.target.value)}
                placeholder="z. B. Abschlussprüfung EÜR 2025"
                maxLength={500}
              />
            </label>
            <Button type="button" variant="secondary" onClick={() => void freezeCurrentReport()} disabled={freezing || !activeReport || activeQualityBlocksFreeze || !freezeReason.trim()} aria-busy={freezing}>
              {freezing ? 'Friere ein…' : 'Snapshot einfrieren'}
            </Button>
            {activeQualityBlocksFreeze ? <p className="basis-full text-xs text-error" role="status">Snapshot kann wegen unvollständiger oder nicht-live Reportdaten nicht eingefroren werden.</p> : null}
          </div>
        ) : <div className="rounded-xl border border-border bg-surface-muted px-3 py-2 text-sm text-muted" role="status">Diese Rolle kann EÜR-Snapshots nur lesen.</div> : null}
        {activeTab === 'eur' && dataAdapter?.listEurCashItems ? (
          <section className="space-y-3 rounded-xl border border-border bg-surface p-3" aria-labelledby="eur-classification-heading">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="eur-classification-heading" className="text-sm font-bold text-foreground">EÜR-Klassifikation 2025</h2>
                <p className="text-xs text-muted">Cash-Basis-Quellen prüfen und einer echten EÜR-Kennziffer zuordnen. Berechnete Zeilen sind nicht auswählbar.</p>
              </div>
              <Button type="button" size="sm" variant="secondary" onClick={() => setReportsRetryKey((current) => current + 1)} disabled={eurItemsLoading} aria-busy={eurItemsLoading}>
                {eurItemsLoading ? 'Lade Quellen…' : 'Quellen aktualisieren'}
              </Button>
            </div>
            {canMutate && dataAdapter.upsertEurClassification ? (
              <label className="flex max-w-xl flex-col gap-1 text-xs font-semibold text-foreground" htmlFor="eur-classification-reason">
                Audit-Grund für Klassifikationen
                <input
                  id="eur-classification-reason"
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-normal"
                  value={eurClassificationReason}
                  onChange={(event) => setEurClassificationReason(event.target.value)}
                  placeholder="z. B. Belegprüfung EÜR 2025"
                  maxLength={500}
                />
              </label>
            ) : <p className="rounded-lg border border-border-subtle bg-surface-muted px-3 py-2 text-sm text-muted" role="status">Diese Rolle kann EÜR-Quellen prüfen, aber nicht klassifizieren.</p>}
            {eurItemsError ? <div className="rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert">{eurItemsError}</div> : null}
            {!eurItemsLoading && !eurItemsError && eurItems.length === 0 ? <p className="text-sm text-muted">Keine Cash-Basis-Quellen im Kalenderjahr 2025.</p> : null}
            {eurItems.length > 0 ? (
              <div className="space-y-2" role="list" aria-label="Unklassifizierte EÜR-Cash-Quellen">
                {eurItems.map((item) => {
                  const key = eurCashItemKey(item);
                  const draft = eurDrafts[key] ?? eurDraftFor(item);
                  return (
                    <div key={key} role="listitem" className="grid gap-2 rounded-lg border border-border-subtle bg-surface-muted p-3 lg:grid-cols-[minmax(12rem,1.4fr)_minmax(14rem,1fr)_auto] lg:items-end">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{item.purpose || item.counterparty || item.sourceId}</p>
                        <p className="text-xs text-muted">{item.date} · {item.flowType === 'income' ? 'Einnahme' : 'Ausgabe'} · {item.amountGross.toFixed(2)} € brutto</p>
                        <p className="truncate text-xs text-muted">Quelle: {item.sourceType}:{item.sourceId}</p>
                        {item.vatWarning ? <p className="text-xs text-warning">{item.vatWarning}</p> : null}
                      </div>
                      {canMutate && dataAdapter.upsertEurClassification ? <div className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto_auto] sm:items-end">
                        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground" htmlFor={`eur-line-${key}`}>
                          EÜR-Zeile
                          <select
                            id={`eur-line-${key}`}
                            className="rounded-lg border border-border bg-surface px-2 py-2 text-sm font-normal"
                            value={draft.eurLineId ?? ''}
                            onChange={(event) => setEurDrafts((current) => ({ ...current, [key]: { ...draft, eurLineId: event.target.value || undefined } }))}
                          >
                            <option value="">Nicht klassifiziert</option>
                            {eurLines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}
                          </select>
                        </label>
                        <label className="flex items-center gap-2 pb-2 text-xs text-foreground" htmlFor={`eur-excluded-${key}`}>
                          <input id={`eur-excluded-${key}`} type="checkbox" checked={draft.excluded} onChange={(event) => setEurDrafts((current) => ({ ...current, [key]: { ...draft, excluded: event.target.checked } }))} />
                          Ausschließen
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground" htmlFor={`eur-vat-${key}`}>
                          USt.
                          <select id={`eur-vat-${key}`} className="rounded-lg border border-border bg-surface px-2 py-2 text-sm font-normal" value={draft.vatMode} onChange={(event) => setEurDrafts((current) => ({ ...current, [key]: { ...draft, vatMode: event.target.value as EurClassificationDraft['vatMode'] } }))}>
                            <option value="none">Keine Aufteilung</option>
                            <option value="default">Netto aus USt-Satz</option>
                          </select>
                        </label>
                        {draft.vatMode === 'default' ? (
                          <label className="flex flex-col gap-1 text-xs font-semibold text-foreground" htmlFor={`eur-vat-rate-${key}`}>
                            USt.-Satz
                            <select
                              id={`eur-vat-rate-${key}`}
                              className="rounded-lg border border-border bg-surface px-2 py-2 text-sm font-normal"
                              value={draft.vatRate ?? ''}
                              onChange={(event) => setEurDrafts((current) => ({ ...current, [key]: { ...draft, vatRate: event.target.value ? Number(event.target.value) : undefined } }))}
                            >
                              <option value="">Bitte wählen</option>
                              <option value="0">0 %</option>
                              <option value="7">7 %</option>
                              <option value="19">19 %</option>
                            </select>
                          </label>
                        ) : null}
                      </div> : null}
                      {canMutate && dataAdapter.upsertEurClassification ? <Button type="button" size="sm" variant="secondary" onClick={() => void saveEurClassification(item)} disabled={eurClassifying !== null || !eurClassificationReason.trim() || (draft.vatMode === 'default' && draft.vatRate === undefined)} aria-busy={eurClassifying === key}>
                        {eurClassifying === key ? 'Speichere…' : 'Speichern'}
                      </Button> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : null}
        {reportsNotice ? <div className="rounded-xl border border-success-border bg-success-bg px-3 py-2 text-sm text-success" role="status" aria-live="polite">{reportsNotice}</div> : null}
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
                    onClose={() => {
                      setDrilldownSelection(null);
                      setDrilldownError(null);
                    }}
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
                <div className="space-y-3">
                  <div className="hidden xl:flex h-full items-center justify-center rounded-2xl border border-dashed border-border bg-surface/70 text-sm text-muted px-6 text-center">
                    Konto- oder Reportzeile anklicken, um Drilldown zu sehen.
                  </div>
                  {drilldownError ? <div className="rounded-xl border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert">{drilldownError}</div> : null}
                </div>
              )}
            </div>
        </div>
        <DatevExportPanel dataAdapter={dataAdapter} chartFramework={filters.chart} role={role} />
      </div>
    </div>
  );
}
