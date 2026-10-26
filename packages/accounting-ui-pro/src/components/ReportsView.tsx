import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Checkbox, FeedbackProvider, Input, Select, useActionFeedback } from '@billme/ui';
import { positionTitle } from '../domain/references';
import {
  isSupportedEurTaxYear,
  LATEST_SUPPORTED_EUR_TAX_YEAR,
  SUPPORTED_EUR_TAX_YEARS,
  type SupportedEurTaxYear,
} from '@billme/accounting-shared';
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
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';
import type { EurAnnexFact, EurCashFact } from '../sourceRuns';
import type { UserRole } from '../types';
import { permissionContextForRole } from '../domain/permissions';
import ReportToolbar from './reports/ReportToolbar';
import ReportTabSwitch from './reports/ReportTabSwitch';
import SusaTable from './reports/SusaTable';
import GuvView from './reports/GuvView';
import BalanceSheetPreviewView from './reports/BalanceSheetPreviewView';
import ReportDrilldownPanel from './reports/ReportDrilldownPanel';
import DatevExportPanel from './reports/DatevExportPanel';
import { defaultReportFilters, nativeEurRange, reportDateRange, reportFiscalYearRange } from '../domain/reportDates';
import ReportStatusBadge, { MappingHealthBlock, reportIsMappingBlocked } from './reports/ReportStatusBadge';
import ReportMappingSetup from './reports/ReportMappingSetup';
import type { ReportMappingStatement } from '../domain/reportMapping';
import {
  downloadReportCsv,
  normalizeReportSnapshot,
  printReportPdf,
  reportFileName,
  reportToCsv,
} from '../domain/reportExport';

type EurClassificationDraft = {
  eurLineId?: string;
  excluded: boolean;
  vatMode: 'none' | 'default';
  vatRate?: number;
  note?: string;
};

type ReportLoadState = {
  status: 'loading' | 'success' | 'error';
  error?: string;
  requestId: number;
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
  /** Opens a tab on a range (both ISO dates), e.g. a month clicked in the overview. Applied whenever it changes. */
  request?: { tab?: string; from?: string; to?: string };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const hasEurFilingProvenance = (report: unknown): boolean => {
  if (!report || typeof report !== 'object') return false;
  const filing = (report as { filing?: unknown }).filing;
  if (!filing || typeof filing !== 'object') return false;
  const value = filing as { kind?: unknown; taxYear?: unknown; catalog?: unknown; lineProvenance?: unknown };
  if (value.kind !== 'euer' || !isSupportedEurTaxYear(Number(value.taxYear)) || !Array.isArray(value.lineProvenance) || value.lineProvenance.length === 0) return false;
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

export default function ReportsView(props: ReportsViewProps) {
  return (
    <FeedbackProvider>
      <ReportsViewContent {...props} />
    </FeedbackProvider>
  );
}

function ReportsViewContent({ dataAdapter, chartFramework, businessReportingProfile, profile = 'all', availableTabs, role = 'admin', onOpenTransaction, onOpenInvoice, onOpenIncomingInvoice, onOpenJournalEntry, request }: ReportsViewProps) {
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
  // A requested range replaces the period (custom, no preset); a requested tab opens when the profile offers it.
  // Keyed by its values: applied once per change (and again after a profile change resets the period above);
  // a later change in the toolbar stays.
  const requestKey = `${request?.tab ?? ''}|${request?.from ?? ''}|${request?.to ?? ''}`;
  useEffect(() => {
    if (request?.tab && visibleTabs.includes(request.tab as ReportTabId)) setActiveTab(request.tab as ReportTabId);
    const from = request?.from; const to = request?.to;
    if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) return;
    setFilters((current) => ({ ...current, asOfDate: to, periodFrom: from.slice(0, 7), periodTo: to.slice(0, 7), periodFromDate: from, periodToDate: to, periodPreset: undefined }));
  }, [requestKey, businessReportingProfile?.chart, businessReportingProfile?.profitDetermination, chartFramework]);
  const [susaReport, setSusaReport] = useState<SusaReport | null>(null);
  const [balanceSheetPreview, setBalanceSheetPreview] = useState<BalanceSheetPreview | null>(null);
  const [eurReport, setEurReport] = useState<GuvReport | null>(null);
  const [bwaReport, setBwaReport] = useState<GuvReport | null>(null);
  const [managementGuvReport, setManagementGuvReport] = useState<GuvReport | null>(null);
  const [hgbGuvReport, setHgbGuvReport] = useState<GuvReport | null>(null);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reportsNotice, setReportsNotice] = useState<string | null>(null);
  const [reportsRetryKey, setReportsRetryKey] = useState(0);
  const reportRequestId = useRef(0);
  const [reportLoadStates, setReportLoadStates] = useState<Partial<Record<ReportTabId, ReportLoadState>>>({});
  const [eurItems, setEurItems] = useState<EurCashItem[]>([]);
  const [eurTaxYear, setEurTaxYear] = useState<SupportedEurTaxYear>(LATEST_SUPPORTED_EUR_TAX_YEAR);
  const eurTaxYearUserSelected = useRef(false);
  const [eurItemsLoading, setEurItemsLoading] = useState(false);
  const [eurItemsError, setEurItemsError] = useState<string | null>(null);
  const [eurDrafts, setEurDrafts] = useState<Record<string, EurClassificationDraft>>({});
  const [eurFactKinds, setEurFactKinds] = useState<Record<string, 'income' | 'expense' | 'private-withdrawal' | 'private-contribution' | 'pass-through'>>({});
  const [eurSplitAmounts, setEurSplitAmounts] = useState<Record<string, string>>({});
  const [eurAnnex, setEurAnnex] = useState('IAB');
  const [eurAnnexLine, setEurAnnexLine] = useState('formed');
  const [eurAnnexAmount, setEurAnnexAmount] = useState('');
  const [eurClassificationReason, setEurClassificationReason] = useState('');
  const [eurClassifying, setEurClassifying] = useState<string | null>(null);
  const [eurCashFacts, setEurCashFacts] = useState<EurCashFact[]>([]);
  const [eurAnnexFacts, setEurAnnexFacts] = useState<EurAnnexFact[]>([]);
  const [eurFactsError, setEurFactsError] = useState<string | null>(null);
  const [eurAnnexBusy, setEurAnnexBusy] = useState(false);

  const filtersForTab = (tab: ReportTabId): ReportFilterState => tab === 'eur'
    ? {
      ...filters,
      asOfDate: nativeEurRange(eurTaxYear).to,
      periodFrom: nativeEurRange(eurTaxYear).from.slice(0, 7),
      periodTo: nativeEurRange(eurTaxYear).to.slice(0, 7),
      periodFromDate: nativeEurRange(eurTaxYear).from,
      periodToDate: nativeEurRange(eurTaxYear).to,
      periodPreset: 'current',
      compareMode: 'none',
    }
    : filters;

  const [drilldownSelection, setDrilldownSelection] = useState<ReportDrilldownSelection | null>(null);
  const [drilldownEntries, setDrilldownEntries] = useState<ReportDrilldownEntry[]>([]);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState<string | null>(null);
  const [drilldownRetryKey, setDrilldownRetryKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [freezeReason, setFreezeReason] = useState('');
  const canMutate = permissionContextForRole(role).canMutate;
  const { notify: notifyExport } = useActionFeedback('reports-export');

  const profileSetupError = businessReportingProfile
    && (businessReportingProfile.legalForm === 'gmbh' || businessReportingProfile.legalForm === 'ug')
    && businessReportingProfile.profitDetermination === 'double_entry'
    && !reportFiscalYearRange(filters.asOfDate, businessReportingProfile)
    ? 'Der Wirtschaftsjahresbeginn ist nicht eingerichtet. Bitte hinterlege in den Einstellungen ein gültiges Datum (MM-TT), bevor du Berichte öffnest.'
    : null;

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) setActiveTab(visibleTabs[0] ?? 'susa');
  }, [activeTab, visibleTabs]);

  useEffect(() => {
    setReportsError(null);
    setReportsNotice(null);
  }, [activeTab]);

  useEffect(() => {
    const requestId = ++reportRequestId.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && reportRequestId.current === requestId;
    const setLoadState = (tab: ReportTabId, state: Omit<ReportLoadState, 'requestId'>) => {
      if (!isCurrent()) return;
      setReportLoadStates((current) => ({ ...current, [tab]: { ...state, requestId } }));
    };
    const setReport = (tab: ReportTabId, report: unknown) => {
      if (!isCurrent()) return;
      switch (tab) {
        case 'susa': setSusaReport(report as SusaReport); break;
        case 'bilanz': setBalanceSheetPreview(report as BalanceSheetPreview); break;
        case 'eur': setEurReport(report as GuvReport); break;
        case 'bwa01': setBwaReport(report as GuvReport); break;
        case 'management_guv': setManagementGuvReport(report as GuvReport); break;
        case 'hgb_guv': setHgbGuvReport(report as GuvReport); break;
      }
    };
    setReportLoadStates((current) => {
      const next = { ...current };
      for (const tab of visibleTabs) next[tab] = { status: 'loading', requestId };
      return next;
    });

    if (profileSetupError) {
      for (const tab of visibleTabs) setLoadState(tab, { status: 'error', error: profileSetupError });
      return () => {
        cancelled = true;
      };
    }

    const missingReportMethod = <T,>(tab: ReportTabId): Promise<T> => Promise.reject(new Error(
      `${tab === 'bwa01' ? 'BWA01' : tab === 'management_guv' ? 'Management-GuV' : tab === 'hgb_guv' ? 'HGB-GuV' : tab === 'bilanz' ? 'Bilanz' : tab === 'eur' ? 'EÜR' : 'SuSa'} ist für diese Verbindung nicht verfügbar. Bitte Reporting-Profil und Adapter-Konfiguration prüfen.`,
    ));
    const load = <T,>(tab: ReportTabId, method: ((value: ReportFilterState) => Promise<T>) | undefined, fallback: (value: ReportFilterState) => Promise<T>, value: ReportFilterState) => {
      if (!dataAdapter) return fallback(value);
      return method ? method(value) : missingReportMethod<T>(tab);
    };
    const requests: Partial<Record<ReportTabId, Promise<unknown>>> = {
      ...(visibleTabs.includes('susa') ? { susa: load('susa', dataAdapter?.getSusaReport, getSusaReport, filtersForTab('susa')) } : {}),
      ...(visibleTabs.includes('bilanz') ? { bilanz: load('bilanz', dataAdapter?.getBalanceSheetPreview, getBalanceSheetPreview, filtersForTab('bilanz')) } : {}),
      ...(visibleTabs.includes('eur') ? { eur: load('eur', dataAdapter?.getEurReport, getEurReport, filtersForTab('eur')) } : {}),
      ...(visibleTabs.includes('bwa01') ? { bwa01: load('bwa01', dataAdapter?.getBwaReport, getBwaReport, filtersForTab('bwa01')) } : {}),
      ...(visibleTabs.includes('management_guv') ? { management_guv: load('management_guv', dataAdapter?.getManagementGuvReport, getManagementGuvReport, filtersForTab('management_guv')) } : {}),
      ...(visibleTabs.includes('hgb_guv') ? { hgb_guv: load('hgb_guv', dataAdapter?.getHgbGuvReport, getHgbGuvReport, filtersForTab('hgb_guv')) } : {}),
    };
    for (const [tab, request] of Object.entries(requests) as Array<[ReportTabId, Promise<unknown>]>) {
      void request
        .then((report) => {
          setReport(tab, report);
          setLoadState(tab, { status: 'success' });
        })
        .catch((error) => {
          setLoadState(tab, { status: 'error', error: error instanceof Error ? error.message : 'Auswertungen konnten nicht geladen werden.' });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [dataAdapter, eurTaxYear, filters, profileSetupError, reportsRetryKey, visibleTabs]);

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
    dataAdapter.listEurCashItems(eurTaxYear)
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
        setEurFactKinds((current) => {
          const next = { ...current };
          for (const item of items) {
            const key = eurCashItemKey(item);
            if (!next[key]) next[key] = item.kind ?? item.flowType;
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
  }, [dataAdapter, eurTaxYear, reportsRetryKey, visibleTabs]);

  useEffect(() => {
    if (!visibleTabs.includes('eur')) {
      setEurCashFacts([]);
      setEurAnnexFacts([]);
      setEurFactsError(null);
      return;
    }
    const cashFacts = dataAdapter?.listEurCashFacts
      ? dataAdapter.listEurCashFacts(eurTaxYear)
      : Promise.resolve([] as EurCashFact[]);
    const annexFacts = dataAdapter?.listEurAnnexFacts
      ? dataAdapter.listEurAnnexFacts(eurTaxYear)
      : Promise.resolve([] as EurAnnexFact[]);
    let cancelled = false;
    setEurFactsError(null);
    Promise.all([cashFacts, annexFacts])
      .then(([cash, annex]) => {
        if (cancelled) return;
        setEurCashFacts(cash);
        setEurAnnexFacts(annex);
      })
      .catch((error) => {
        if (!cancelled) setEurFactsError(error instanceof Error ? error.message : 'EÜR-Fakten konnten nicht geladen werden.');
      });
    return () => {
      cancelled = true;
    };
  }, [dataAdapter, eurTaxYear, reportsRetryKey, visibleTabs]);

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
  useEffect(() => {
    if (eurTaxYearUserSelected.current || activeTab !== 'eur' || !activeReport || typeof activeReport !== 'object' || !('filing' in activeReport)) return;
    const taxYear = (activeReport.filing as { taxYear?: unknown } | undefined)?.taxYear;
    if (typeof taxYear === 'number' && isSupportedEurTaxYear(taxYear) && taxYear !== eurTaxYear) setEurTaxYear(taxYear);
  }, [activeReport, activeTab, eurTaxYear]);
  const activeReportLoadState = reportLoadStates[activeTab];
  const activeReportLoading = !activeReportLoadState || activeReportLoadState.status === 'loading';
  const activeReportLoadError = activeReportLoadState?.status === 'error' ? activeReportLoadState.error : null;
  const reportError = activeReportLoadError ?? reportsError;
  const unavailableCatalogYear = reportError?.match(/PUBLIC_REPORT_CATALOG_UNAVAILABLE:(\d+)/)?.[1];
  const reportErrorMessage = unavailableCatalogYear
    ? unavailableCatalogYear === '0'
      ? `Für den Report konnte kein Berichtsstichtag ermittelt werden. Unterstützte Geschäftsjahre sind ${SUPPORTED_EUR_TAX_YEARS.join(' und ')}.`
      : `Für das Geschäftsjahr ${unavailableCatalogYear} ist kein Berichtskatalog verfügbar. Unterstützte Geschäftsjahre sind ${SUPPORTED_EUR_TAX_YEARS.join(' und ')}.`
    : reportError;
  const activeReportUnavailable = activeReportLoadState?.status === 'success' && !activeReport;
  const activeQuality = activeReport?.quality;
  const exportBlockedReason = activeReportLoading
    ? 'Export ist erst möglich, wenn der aktuelle Report geladen ist.'
    : activeReportLoadError
      ? 'Export nicht verfügbar: Der aktuelle Report konnte nicht geladen werden.'
      : activeReportUnavailable
        ? 'Export nicht verfügbar: Für den aktuellen Report liegen keine Daten vor.'
        : activeQuality && reportIsMappingBlocked(activeQuality)
          ? 'Export nicht verfügbar: Das Konten-Mapping des aktuellen Reports ist unvollständig.'
        : undefined;
  useEffect(() => {
    if (activeTab !== 'bilanz' || !balanceSheetPreview || !reportIsMappingBlocked(balanceSheetPreview.quality)) return;
    setDrilldownSelection(null);
    setDrilldownEntries([]);
  }, [activeTab, balanceSheetPreview]);
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
      setReportsError('Bitte gib einen Audit-Grund für die EÜR-Klassifikation an.');
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
        taxYear: eurTaxYear,
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

  const saveEurFact = async (item: EurCashItem) => {
    if (!dataAdapter?.saveEurCashFact) return;
    const reason = eurClassificationReason.trim();
    const key = eurCashItemKey(item);
    const splitAmount = Number(eurSplitAmounts[key]);
    const splitCents = Number.isFinite(splitAmount) ? Math.round(splitAmount * 100) : 0;
    const itemCents = Math.round(item.amountNet * 100);
    if (!reason) { setReportsError('Bitte gib einen Audit-Grund für den EÜR-Fakt an.'); return; }
    if (eurSplitAmounts[key] && (!Number.isFinite(splitAmount) || splitCents <= 0 || splitCents > itemCents)) { setReportsError('Aufteilung muss zwischen 0 und dem Netto-Betrag liegen.'); return; }
    if (eurSplitAmounts[key] && (eurFactKinds[key] ?? item.flowType) !== 'expense') { setReportsError('Aufteilungen sind nur für Ausgaben möglich.'); return; }
    if (eurSplitAmounts[key] && !eurDrafts[key]?.eurLineId) { setReportsError('Für den abzugsfähigen Split muss eine EÜR-Zeile gewählt werden.'); return; }
    const splits = eurSplitAmounts[key]
      ? [
        { amountNet: splitCents / 100, deductibility: 'deductible' as const, lineId: eurDrafts[key]?.eurLineId, reason },
        ...(itemCents > splitCents
          ? [{ amountNet: (itemCents - splitCents) / 100, deductibility: 'non-deductible' as const, reason: `${reason} · Restbetrag nicht abzugsfähig` }]
          : []),
      ]
      : undefined;
    setEurClassifying(key);
    try {
      await dataAdapter.saveEurCashFact({
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        taxYear: eurTaxYear,
        kind: eurFactKinds[key] ?? item.flowType,
        amountNet: item.amountNet,
        flowType: item.flowType,
        eurLineId: eurDrafts[key]?.eurLineId,
        splits,
        reason,
      });
      setReportsNotice('EÜR-Fakt gespeichert und refetched.');
      setReportsRetryKey((current) => current + 1);
    } catch (error) {
      setReportsError(error instanceof Error ? error.message : 'EÜR-Fakt konnte nicht gespeichert werden.');
    } finally { setEurClassifying(null); }
  };

  const saveEurAnnexFact = async () => {
    if (!dataAdapter?.saveEurAnnexFact || eurAnnexBusy) return;
    const amount = Number(eurAnnexAmount);
    if (!eurClassificationReason.trim()) { setReportsError('Bitte gib einen Audit-Grund für den Anlagen-Fakt an.'); return; }
    if (!Number.isFinite(amount) || amount === 0) { setReportsError('Anlagen-Betrag muss ungleich 0 sein.'); return; }
    setEurAnnexBusy(true);
    try {
      await dataAdapter.saveEurAnnexFact({
        taxYear: eurTaxYear,
        annex: eurAnnex,
        lineId: eurAnnexLine,
        amount,
        reason: eurClassificationReason.trim(),
        date: nativeEurRange(eurTaxYear).to,
        idempotencyKey: `eur-annex:${eurTaxYear}:${eurAnnex}:${eurAnnexLine}:${nativeEurRange(eurTaxYear).to}:${amount}`,
      });
      setReportsNotice('Anlagen-Fakt gespeichert und refetched.');
      setEurAnnexAmount('');
      setReportsRetryKey((current) => current + 1);
    } catch (error) { setReportsError(error instanceof Error ? error.message : 'Anlagen-Fakt konnte nicht gespeichert werden.'); }
    finally { setEurAnnexBusy(false); }
  };

  const eurLines = useMemo(
    () => (eurReport?.lines ?? []).filter((line) => !line.isSubtotal),
    [eurReport?.lines],
  );

  const exportReport = async (format: 'pdf' | 'csv') => {
    if (activeReportLoading || activeReportLoadError || activeReportUnavailable || !activeReport || (activeQuality && reportIsMappingBlocked(activeQuality))) return;
    setExporting(true);
    notifyExport('progress', `${format.toUpperCase()}-Export läuft…`);
    const effectiveFilters = filtersForTab(activeTab);
    const request: ReportExportRequest = { report: activeTab, filters: effectiveFilters, format };
    try {
      let result: ReportExportResult | void;
      const adapter = dataAdapter;
      const adapterExporter = adapter?.exportReport
        ?? (format === 'pdf' ? adapter?.exportReportPdf : adapter?.exportReportCsv);
      if (adapterExporter) {
        result = adapter?.exportReport
          ? await adapter.exportReport(request)
          : format === 'pdf'
            ? await adapter!.exportReportPdf!({ report: activeTab, filters: effectiveFilters })
            : await adapter!.exportReportCsv!({ report: activeTab, filters: effectiveFilters });
        if (format === 'csv' && result?.content !== undefined) {
          downloadReportCsv(result.content, result.fileName ?? reportFileName(activeTab, format));
        }
        const successMessage = result?.path
          ? `Export erstellt: ${result.path}`
          : `${format.toUpperCase()}-Export erstellt.`;
        setReportsNotice(null);
        notifyExport('success', successMessage);
      } else {
        const normalized = normalizeReportSnapshot(activeTab, activeReport, effectiveFilters);
        if (format === 'csv') {
          downloadReportCsv(reportToCsv(normalized), reportFileName(activeTab, format));
          notifyExport('success', 'CSV-Export erstellt.');
        } else {
          await printReportPdf(normalized);
          setReportsNotice(null);
          notifyExport('success', 'Druckdialog geöffnet.');
        }
      }
    } catch (error) {
      setReportsNotice(null);
      const message = error instanceof Error ? error.message : 'Report-Export fehlgeschlagen.';
      notifyExport('error', message);
    } finally {
      setExporting(false);
    }
  };

  const freezeCurrentReport = async () => {
    if (!canMutate || !dataAdapter?.saveReportSnapshot || !activeReport || activeTab !== 'eur' || activeQualityBlocksFreeze) return;
    const effectiveFilters = filtersForTab('eur');
    const range = reportDateRange(effectiveFilters);
    if (range.from !== nativeEurRange(eurTaxYear).from || range.to !== nativeEurRange(eurTaxYear).to) {
      setReportsNotice(null);
      setReportsError(`Für das Filing-Center kann nur ein vollständiger EÜR-${eurTaxYear}-Zeitraum eingefroren werden.`);
      return;
    }
    const reason = freezeReason.trim();
    if (!reason) {
      setReportsNotice(null);
      setReportsError('Bitte gib einen Audit-Grund für das Einfrieren des EÜR-Snapshots an.');
      return;
    }
    setFreezing(true);
    setReportsError(null);
    setReportsNotice(null);
    try {
      await dataAdapter.saveReportSnapshot({
        reportType: activeTab,
        args: effectiveFilters,
        payload: {
          ...activeReport,
          ...(dataAdapter.listEurCashFacts ? { eurCashFacts } : {}),
          ...(dataAdapter.listEurAnnexFacts ? { eurAnnexFacts } : {}),
        },
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
      targetLabel: positionTitle(line),
      accountNumbers: line.accountRefs ?? [],
      ...range,
    });
  };

  const handleBilanzSelect = (line: BalanceSheetPreviewLine) => {
    if (reportIsMappingBlocked(balanceSheetPreview?.quality)) {
      setDrilldownSelection(null);
      setDrilldownEntries([]);
      setDrilldownError('Bilanz-Drilldown ist wegen eines unvollständigen Konten-Mappings gesperrt.');
      return;
    }
    if (!line.accountRefs?.length) {
      setDrilldownSelection(null);
      setDrilldownEntries([]);
      setDrilldownError('Für diese Bilanzposition ist kein Konten-Mapping verfügbar. Bitte richte das Mapping ein, bevor du den Drilldown öffnest.');
      return;
    }
    setDrilldownError(null);
    setDrilldownSelection({
      reportType: 'bilanz',
      targetId: line.id,
      targetLabel: positionTitle(line),
      accountNumbers: line.accountRefs,
      to: filters.asOfDate,
    });
  };

  return (
    <div className="min-w-0 space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ReportTabSwitch activeTab={activeTab} onChange={setActiveTab} tabs={visibleTabs} />
        <ReportStatusBadge quality={activeQuality} />
      </div>
      <ReportToolbar
        filters={filtersForTab(activeTab)}
        onChange={setFilters}
        activeTab={activeTab}
        onExport={exportReport}
        exporting={exporting}
        exportBlockedReason={exportBlockedReason}
        lockNativeEurPeriod={activeTab === 'eur'}
        nativeEurTaxYear={eurTaxYear}
      />
      <ReportMappingSetup
        dataAdapter={dataAdapter}
        chart={filters.chart}
        role={role}
        statements={mappingStatements}
        asOfDate={mappingAsOfDate}
        validFrom={reportDateRange(filters).from ?? mappingAsOfDate}
        refreshKey={reportsRetryKey}
        onMappingChanged={() => setReportsRetryKey((current) => current + 1)}
        activeReportMapping={{ label: activeReportLabel, blocked: Boolean(activeQuality && reportIsMappingBlocked(activeQuality)) }}
      />
      {activeTab === 'eur' && dataAdapter?.saveReportSnapshot ? canMutate ? (
        <Card className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <Input
              id="report-freeze-reason"
              label="Audit-Grund für EÜR-Snapshot"
              value={freezeReason}
              onChange={(event) => setFreezeReason(event.target.value)}
              placeholder={`z. B. Abschlussprüfung EÜR ${eurTaxYear}`}
              maxLength={500}
              fullWidth
            />
          </div>
          <Button type="button" variant="secondary" onClick={() => void freezeCurrentReport()} disabled={freezing || !activeReport || activeQualityBlocksFreeze || !freezeReason.trim()} aria-busy={freezing}>
            {freezing ? 'Friere ein…' : 'Snapshot einfrieren'}
          </Button>
          {activeQualityBlocksFreeze ? <p className="basis-full text-caption text-error-text" role="status">Snapshot kann wegen unvollständiger oder nicht-live Reportdaten nicht eingefroren werden.</p> : null}
        </Card>
      ) : <div className="rounded-control border border-border bg-surface-sunken px-3 py-2.5 text-control text-muted" role="status">Diese Rolle kann EÜR-Snapshots nur lesen.</div> : null}
      {activeTab === 'eur' && (dataAdapter?.listEurCashItems || dataAdapter?.listEurCashFacts || dataAdapter?.listEurAnnexFacts) ? (
        <section className="rounded-card border border-border bg-surface" aria-labelledby="eur-classification-heading">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-3.5 py-3">
            <div className="min-w-48 flex-1">
              <h2 id="eur-classification-heading" className="text-section text-foreground">EÜR-Klassifikation {eurTaxYear}</h2>
              <p className="mt-0.5 text-caption text-muted">Cash-Basis-Quellen prüfen und einer echten EÜR-Kennziffer zuordnen. Private, durchlaufende und geteilte Fakten bleiben nachvollziehbar.</p>
            </div>
            <Select
              id="eur-tax-year"
              label="Steuerjahr"
              value={eurTaxYear}
              onChange={(event) => {
                const year = Number(event.target.value);
                if (isSupportedEurTaxYear(year)) {
                  eurTaxYearUserSelected.current = true;
                  setEurTaxYear(year);
                }
              }}
            >
              {SUPPORTED_EUR_TAX_YEARS.map((year) => <option key={year} value={year}>{year}</option>)}
            </Select>
            <Button type="button" variant="secondary" onClick={() => setReportsRetryKey((current) => current + 1)} disabled={eurItemsLoading} aria-busy={eurItemsLoading}>
              {eurItemsLoading ? 'Lade Quellen…' : 'Quellen aktualisieren'}
            </Button>
          </div>
          <div className="space-y-3 p-3.5">
            {canMutate && (dataAdapter.upsertEurClassification || dataAdapter.saveEurCashFact || dataAdapter.saveEurAnnexFact) ? (
              <div className="max-w-xl">
                <Input
                  id="eur-classification-reason"
                  label="Audit-Grund für Klassifikationen"
                  value={eurClassificationReason}
                  onChange={(event) => setEurClassificationReason(event.target.value)}
                  placeholder={`z. B. Belegprüfung EÜR ${eurTaxYear}`}
                  maxLength={500}
                  fullWidth
                />
              </div>
            ) : <p className="rounded-control border border-border bg-surface-sunken px-3 py-2.5 text-control text-muted" role="status">Diese Rolle kann EÜR-Quellen prüfen, aber nicht klassifizieren.</p>}
            {eurItemsError ? <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert">{eurItemsError}</div> : null}
            {eurFactsError ? <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert">{eurFactsError}</div> : null}
            {!eurItemsLoading && !eurItemsError && eurItems.length === 0 ? <p className="text-control text-muted">Keine Cash-Basis-Quellen im Kalenderjahr {eurTaxYear}.</p> : null}
            {eurItems.length > 0 ? (
              <div className="divide-y divide-border border-y border-border" role="list" aria-label="Unklassifizierte EÜR-Cash-Quellen">
                {eurItems.map((item) => {
                  const key = eurCashItemKey(item);
                  const draft = eurDrafts[key] ?? eurDraftFor(item);
                  return (
                    <div key={key} role="listitem" className="grid gap-2 py-3 lg:grid-cols-[minmax(12rem,1.4fr)_minmax(14rem,1fr)_auto] lg:items-end">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{item.purpose || item.counterparty || item.sourceId}</p>
                        <p className="text-caption text-muted">{item.date} · {item.flowType === 'income' ? 'Einnahme' : 'Ausgabe'} · <span className="tabular-nums">{item.amountGross.toFixed(2)} €</span> brutto</p>
                        <p className="truncate text-caption text-muted">Quelle: {item.sourceType}:{item.sourceId}</p>
                        {item.vatWarning ? <p className="text-caption text-warning-text">{item.vatWarning}</p> : null}
                      </div>
                      {canMutate && (dataAdapter.upsertEurClassification || dataAdapter.saveEurCashFact) ? <div className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto_auto] sm:items-end">
                        {dataAdapter.saveEurCashFact ? (
                          <Select id={`eur-kind-${key}`} label="Faktart" fullWidth value={eurFactKinds[key] ?? item.flowType} onChange={(event) => setEurFactKinds((current) => ({ ...current, [key]: event.target.value as typeof eurFactKinds[string] }))}>
                            <option value="income">Einnahme</option><option value="expense">Ausgabe</option><option value="private-withdrawal">Privatentnahme</option><option value="private-contribution">Privateinlage</option><option value="pass-through">Durchlaufender Posten</option>
                          </Select>
                        ) : null}
                        <Select
                          id={`eur-line-${key}`}
                          label="EÜR-Zeile"
                          fullWidth
                          value={draft.eurLineId ?? ''}
                          onChange={(event) => setEurDrafts((current) => ({ ...current, [key]: { ...draft, eurLineId: event.target.value || undefined } }))}
                        >
                          <option value="">Nicht klassifiziert</option>
                          {eurLines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}
                        </Select>
                        <Checkbox
                          id={`eur-excluded-${key}`}
                          label="Ausschließen"
                          className="pb-2"
                          checked={draft.excluded}
                          onChange={(event) => setEurDrafts((current) => ({ ...current, [key]: { ...draft, excluded: event.target.checked } }))}
                        />
                        <Select id={`eur-vat-${key}`} label="USt." fullWidth value={draft.vatMode} onChange={(event) => setEurDrafts((current) => ({ ...current, [key]: { ...draft, vatMode: event.target.value as EurClassificationDraft['vatMode'] } }))}>
                          <option value="none">Keine Aufteilung</option>
                          <option value="default">Netto aus USt-Satz</option>
                        </Select>
                        {draft.vatMode === 'default' ? (
                          <Select
                            id={`eur-vat-rate-${key}`}
                            label="USt.-Satz"
                            fullWidth
                            value={draft.vatRate ?? ''}
                            onChange={(event) => setEurDrafts((current) => ({ ...current, [key]: { ...draft, vatRate: event.target.value ? Number(event.target.value) : undefined } }))}
                          >
                            <option value="">Bitte wählen</option>
                            <option value="0">0 %</option>
                            <option value="7">7 %</option>
                            <option value="19">19 %</option>
                          </Select>
                        ) : null}
                        {dataAdapter.saveEurCashFact ? (
                          <Input
                            id={`eur-split-${key}`}
                            label="Split-Netto (optional)"
                            hint="Restbetrag wird als nicht abzugsfähig gespeichert."
                            type="number"
                            min="0"
                            step="0.01"
                            fullWidth
                            value={eurSplitAmounts[key] ?? ''}
                            onChange={(event) => setEurSplitAmounts((current) => ({ ...current, [key]: event.target.value }))}
                          />
                        ) : null}
                      </div> : null}
                      {canMutate && dataAdapter.upsertEurClassification ? <Button type="button" variant="secondary" onClick={() => void saveEurClassification(item)} disabled={eurClassifying !== null || !eurClassificationReason.trim() || (draft.vatMode === 'default' && draft.vatRate === undefined)} aria-busy={eurClassifying === key}>
                        {eurClassifying === key ? 'Speichere…' : 'Speichern'}
                      </Button> : null}
                      {canMutate && dataAdapter.saveEurCashFact ? <Button type="button" variant="secondary" onClick={() => void saveEurFact(item)} disabled={eurClassifying !== null || !eurClassificationReason.trim()} aria-busy={eurClassifying === key}>Fakt speichern</Button> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {canMutate && dataAdapter.saveEurAnnexFact ? <div className="grid gap-2 sm:grid-cols-[8rem_10rem_minmax(8rem,1fr)_auto] sm:items-end" aria-label="EÜR-Anlagen-Fakt">
              <Select label="Anlage" fullWidth value={eurAnnex} onChange={(event) => setEurAnnex(event.target.value)}>
                <option value="IAB">IAB</option><option value="annex">Weitere Anlage</option>
              </Select>
              <Input label="Zeile" fullWidth value={eurAnnexLine} onChange={(event) => setEurAnnexLine(event.target.value)} />
              <Input label="Betrag" type="number" step="0.01" fullWidth value={eurAnnexAmount} onChange={(event) => setEurAnnexAmount(event.target.value)} />
              <Button type="button" variant="secondary" onClick={() => void saveEurAnnexFact()} disabled={eurAnnexBusy || !eurClassificationReason.trim() || eurAnnexAmount === ''} aria-busy={eurAnnexBusy}>{eurAnnexBusy ? 'Speichere…' : 'Anlagen-Fakt speichern'}</Button>
            </div> : null}
            {eurAnnexFacts.length > 0 ? <div className="border-t border-border pt-3" aria-label="Gespeicherte EÜR-Anlagen-Fakten">
              <p className="text-label text-foreground">Gespeicherte Anlagen-Fakten</p>
              <ul className="mt-1.5 space-y-1 text-caption text-muted">
                {eurAnnexFacts.map((fact) => <li key={fact.id}>{fact.annex} · {fact.lineId} · <span className="tabular-nums">{fact.amount.toFixed(2)} €</span></li>)}
              </ul>
            </div> : null}
          </div>
        </section>
      ) : null}
      {reportsNotice ? <div className="rounded-control border border-success-border bg-success-bg px-3 py-2.5 text-control text-success-text" role="status" aria-live="polite">{reportsNotice}</div> : null}

      <div className="flex min-w-0 flex-col gap-3.5 xl:flex-row">
        <div className="min-w-0 flex-1 space-y-3.5">
          {activeReportLoading ? (
            <Card className="text-control text-muted">
              Lade Auswertungen…
            </Card>
          ) : activeReportLoadError || reportsError ? (
            <div className="flex flex-wrap items-center gap-3 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">
              <span>{reportErrorMessage}</span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setReportsRetryKey((current) => current + 1)}
                disabled={activeReportLoading}
                aria-busy={activeReportLoading}
              >
                {activeReportLoading ? 'Lade erneut…' : 'Erneut versuchen'}
              </Button>
            </div>
          ) : activeReportUnavailable ? (
            <div className="flex flex-wrap items-center gap-3 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">
              <span>Für den aktuellen Report liegen keine Daten vor.</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => setReportsRetryKey((current) => current + 1)}>
                Erneut versuchen
              </Button>
            </div>
          ) : (
            <>
              <MappingHealthBlock quality={activeQuality} />
              {!activeQuality || reportIsMappingBlocked(activeQuality) ? null : activeTab === 'susa' ? (
                <SusaTable report={susaReport} onSelectRow={handleSusaSelect} onRetry={() => setReportsRetryKey((current) => current + 1)} />
              ) : activeTab === 'bilanz' ? (
                <BalanceSheetPreviewView report={balanceSheetPreview} onSelectLine={handleBilanzSelect} onRetry={() => setReportsRetryKey((current) => current + 1)} />
              ) : (
                <GuvView report={activeReport as GuvReport | null} title={activeReportLabel} onSelectLine={handleGuvSelect} onRetry={() => setReportsRetryKey((current) => current + 1)} />
              )}
            </>
          )}
        </div>

        <div className={`min-w-0 w-full space-y-3 ${drilldownSelection ? 'xl:w-96' : 'xl:w-72'}`}>
          {drilldownSelection ? (
            <>
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
                <div className="flex flex-wrap items-center gap-3 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">
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
            </>
          ) : (
            <>
              <div className="hidden rounded-card border border-dashed border-border-strong px-4 py-6 text-center text-caption text-muted xl:block">
                Konto- oder Reportzeile anklicken, um Drilldown zu sehen.
              </div>
              {drilldownError ? <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert">{drilldownError}</div> : null}
            </>
          )}
        </div>
      </div>
      <DatevExportPanel dataAdapter={dataAdapter} chartFramework={filters.chart} role={role} />
    </div>
  );
}
