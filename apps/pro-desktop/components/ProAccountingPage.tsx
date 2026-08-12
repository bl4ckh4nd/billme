import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { Button } from '@billme/ui';
import {
  ProAccountingWorkspace,
  NATIVE_EUR_2025_RANGE,
  reportDateRange,
  type ReportFilterState,
  type ProAccountingDataAdapter,
  type ProAccountingSeed,
  type Transaction as ProUiTransaction,
  type Account as ProUiAccount,
  type BookingDraft as ProUiBookingDraft,
  type EurCashItem,
} from '@billme/accounting-ui-pro';
import { ipc } from '../ipc/client';
import { useAccountsQuery } from '../hooks/useAccounts';
import { useSettingsQuery } from '../hooks/useSettings';
import { useImportSkrMutation, useProLedgerAccountsQuery, useProLedgerStatsQuery } from '../hooks/useProLedger';
import type { IpcArgs, IpcResult } from '../ipc/contract';
import type {
  Bwa01Report,
  HgbBilanzReport,
  HgbGuvReport,
  IncomingInvoiceEntity,
  ManagementGuvReport,
  OpenItemPaymentInput,
  ReportKind,
  ReportResult,
} from '@billme/accounting-shared';
import type { OposBankTransaction } from '@billme/accounting-ui-pro';
import { ProAccountRulesModal } from './ProAccountRulesModal';
import {
  mapBwa01Report,
  mapEurReport,
  mapGuvReport,
  mapHgbGuvReport,
  mapHgbBilanzReport,
  mapManagementGuvReport,
  mapReportDrilldownEntries,
  mapSusaReport,
} from './reportAdapters';

const reportPeriodRange = (filters: ReportFilterState): { from?: string; to?: string } =>
  reportDateRange(filters);

const requireMutationReason = (reason: string, operation: string): string => {
  const normalized = reason.trim();
  if (!normalized) throw new Error(`${operation}: Audit-Grund erforderlich.`);
  return normalized;
};

type NativeEurListItem = IpcResult<'eur:listItems'>[number];

/** The native EÜR UI is deliberately limited to the verified 2025 filing. */
const mapNativeEurCashItem = (item: NativeEurListItem): EurCashItem => {
  if (item.classification && item.classification.taxYear !== 2025) {
    throw new Error(`EUR_UNSUPPORTED_TAX_YEAR:${item.classification.taxYear}`);
  }
  const classification = item.classification
    ? { ...item.classification, taxYear: 2025 as const }
    : undefined;
  return {
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    date: item.date,
    amountGross: item.amountGross,
    amountNet: item.amountNet,
    flowType: item.flowType,
    counterparty: item.counterparty,
    purpose: item.purpose,
    vatWarning: item.vatWarning,
    classification,
  };
};

/**
 * Reporting tabs must consume the shared, report-specific engine route. Do
 * not fall back to getGuvReport here: that would make BWA01, management GuV,
 * and HGB GuV appear identical while hiding their mapping health.
 */
const runReportingReport = async (
  kind: Extract<ReportKind, 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz'>,
  range: { from?: string; to?: string },
): Promise<ReportResult<object>> => {
  return ipc.pro.getReportingReport({ kind, ...range }) as unknown as ReportResult<object>;
};

type DatevExportArgs = {
  from: string;
  to: string;
  consultantNumber: string;
  clientNumber: string;
  fiscalYearStart: string;
  accountLength: number;
  encoding: 'cp1252' | 'utf8-bom';
};

const inferAccountType = (accountNumber: string): ProUiAccount['type'] => {
  const first = accountNumber[0];
  if (first === '0' || first === '1') return 'Asset';
  if (first === '2' || first === '3') return 'Equity';
  if (first === '8' || first === '9') return 'Revenue';
  if (first === '4' || first === '5' || first === '6' || first === '7') return 'Expense';
  return 'Asset';
};

const mapLedgerAccounts = (
  rows: Awaited<ReturnType<typeof ipc.pro.listLedgerAccounts>>,
): ProUiAccount[] => {
  return rows.map((row) => ({
    id: row.accountNumber,
    number: row.accountNumber,
    name: row.name,
    type: inferAccountType(row.accountNumber),
    keywords: row.keywords && row.keywords.length > 0 ? row.keywords : [row.name],
  }));
};

const mapLedgerAccountNames = (
  rows: Awaited<ReturnType<typeof ipc.pro.listLedgerAccounts>>,
): ReadonlyMap<string, string> => new Map(rows.map((row) => [row.accountNumber, row.name]));

const mapTransactions = (
  rows: Awaited<ReturnType<typeof ipc.pro.listBankTransactions>>,
  virtualPostedTransactionIds: ReadonlySet<string> = new Set(),
): ProUiTransaction[] => {
  return rows.map((row) => {
    const workflowStatus: ProUiTransaction['workflowStatus'] =
      row.status === 'booked' || row.linkedInvoiceId ? 'posted' : 'imported';
    const missingReceipt = !row.linkedInvoiceId;

    return {
      id: row.id,
      date: row.date,
      payee: row.counterparty || 'Unbekannt',
      description: row.purpose || 'Importierte Transaktion',
      amount: Number(row.amount || 0),
      currency: 'EUR',
      workflowStatus,
      suggestion: row.suggestedAccountNumber,
      suggestionConfidence: row.suggestionConfidence,
      hasReceipt: !missingReceipt,
      issueCounts: {
        errors: 0,
        warnings: missingReceipt ? 1 : 0,
        infos: 0,
      },
      flags: missingReceipt ? ['missing_receipt'] : [],
      bookingDraftId: `draft-${row.id}`,
      owner: 'Pro Workspace',
      isVirtualPosted:
        row.status === 'booked' &&
        virtualPostedTransactionIds.has(row.id),
    };
  });
};

const mapEntityDraftToUiDraft = (
  draft: NonNullable<IpcResult<'pro:getDraftByTransactionId'>>,
  accountNames: ReadonlyMap<string, string> = new Map(),
  chartFramework: 'SKR03' | 'SKR04' = 'SKR03',
  workflowStatus: ProUiBookingDraft['workflowStatus'] = draft.workflowStatus,
): ProUiBookingDraft => {
  return {
    id: draft.id,
    transactionId: draft.transactionId,
    workflowStatus,
    documentDate: draft.documentDate,
    postingDate: draft.postingDate,
    serviceDate: draft.documentDate,
    bookingText: draft.bookingText,
    externalReference: draft.reference,
    chartFramework,
    lines: draft.lines.map((line) => {
      const hasDebit = Number(line.debitAmount || 0) > 0;
      const amount = hasDebit ? Number(line.debitAmount || 0) : Number(line.creditAmount || 0);
      return {
        id: line.id,
        accountId: line.accountNumber,
        accountName: accountNames.get(line.accountNumber) ?? line.accountNumber,
        type: hasDebit ? 'Soll' : 'Haben',
        amount,
        taxCode: line.taxCode,
        taxCaseKey: line.taxCaseKey,
        taxRate: line.taxRate,
        netAmount: line.netAmount,
        taxAmount: line.taxAmount,
        grossAmount: line.grossAmount,
        countryCode: line.countryCode,
        counterpartyVatId: line.counterpartyVatId,
        evidenceType: line.evidenceType,
        evidenceReference: line.evidenceReference,
        costCenter: line.costCenter,
      };
    }),
    validationIssues: draft.validationIssues.map((issue) => ({
      id: issue.id,
      code: issue.code as any,
      severity: issue.severity,
      message: issue.message,
      fieldPath: issue.fieldPath,
      blocking: issue.blocking,
      source: issue.source,
    })),
    activity: [],
    isVirtualProjection: draft.isVirtualProjection,
    assignedTo: undefined,
    approval: {
      required: false,
      status: 'not_required',
    },
  };
};

const mapUiDraftToEntityDraft = (
  draft: ProUiBookingDraft,
): IpcArgs<'pro:saveDraft'>['draft'] => {
  return {
    id: draft.id,
    tenantId: 'default',
    transactionId: draft.transactionId,
    workflowStatus: draft.workflowStatus,
    postingDate: draft.postingDate,
    documentDate: draft.documentDate,
    bookingText: draft.bookingText,
    reference: draft.externalReference,
    period: (draft.postingDate ?? new Date().toISOString().slice(0, 10)).slice(0, 7),
    fiscalYear: Number((draft.postingDate ?? new Date().toISOString().slice(0, 10)).slice(0, 4)),
    lines: draft.lines.map((line) => ({
      id: line.id,
      accountNumber: line.accountId,
      debitAmount: line.type === 'Soll' ? Number(line.amount || 0) : 0,
      creditAmount: line.type === 'Haben' ? Number(line.amount || 0) : 0,
      taxCode: line.taxCode,
      taxCaseKey: line.taxCaseKey,
      taxRate: line.taxRate,
      netAmount: line.netAmount,
      taxAmount: line.taxAmount,
      grossAmount: line.grossAmount,
      countryCode: line.countryCode,
      counterpartyVatId: line.counterpartyVatId,
      evidenceType: line.evidenceType,
      evidenceReference: line.evidenceReference,
      costCenter: line.costCenter,
      memo: undefined,
    })),
    validationIssues: draft.validationIssues.map((issue) => ({
      id: issue.id,
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      fieldPath: issue.fieldPath,
      blocking: issue.blocking,
      source: issue.source,
    })),
    updatedAt: new Date().toISOString(),
  };
};

export const ProAccountingPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { data: settings } = useSettingsQuery();
  const { data: ledgerStats, isError: ledgerStatsError, error: ledgerStatsLoadError } = useProLedgerStatsQuery();
  const policyQuery = useQuery({
    queryKey: ['pro-accounting', 'policy'],
    queryFn: () => ipc.pro.getAccountingPolicy(),
  });
  const activeChart = policyQuery.data?.activeChart ?? 'SKR03';
  const businessReportingProfile = React.useMemo(() => {
    const profile = settings?.businessReportingProfile;
    if (!profile) return undefined;
    return {
      legalForm: profile.legalForm,
      profitDetermination: profile.profitDetermination,
      fiscalYearStart: profile.fiscalYearStart,
      chart: profile.chart,
    };
  }, [settings?.businessReportingProfile]);
  const { data: ledgerAccounts = [], isError: ledgerAccountsError, error: ledgerAccountsLoadError } = useProLedgerAccountsQuery({
    chart: activeChart,
    limit: 10_000,
  });
  const { data: bankAccounts = [], isError: bankAccountsError, error: bankAccountsLoadError } = useAccountsQuery();
  const txQuery = useQuery({
    queryKey: ['pro-accounting', 'transactions'],
    queryFn: () => ipc.pro.listBankTransactions(),
  });
  const draftQuery = useQuery({
    queryKey: ['pro-accounting', 'drafts', txQuery.data?.map((tx) => tx.id).join('|') ?? 'none'],
    enabled: Boolean(txQuery.data && txQuery.data.length > 0),
    queryFn: async () => {
      const txRows = txQuery.data ?? [];
      const rows = await Promise.all(
        txRows.map(async (tx) => ipc.pro.getDraftByTransactionId({ transactionId: tx.id })),
      );
      return rows.filter((row) => row !== null);
    },
  });
  const importSkr = useImportSkrMutation();
  const [showRulesModal, setShowRulesModal] = React.useState(false);
  const [importMessage, setImportMessage] = React.useState<string | null>(null);
  const [importFailed, setImportFailed] = React.useState(false);
  const [adapterBusy, setAdapterBusy] = React.useState(false);
  const [adapterError, setAdapterError] = React.useState<string | null>(null);

  const seed = React.useMemo<ProAccountingSeed>(() => {
    const draftMap = new Map<string, ProUiBookingDraft>();
    const draftRows = draftQuery.data ?? [];
    const transactionRows = txQuery.data ?? [];
    const bankStatusByTransactionId = new Map(transactionRows.map((tx) => [tx.id, tx.status]));
    const virtualPostedTransactionIds = new Set(
      draftRows
        .filter((draft) => draft.isVirtualProjection)
        .map((draft) => draft.transactionId),
    );
    const activeLedgerAccounts = ledgerAccounts.filter((row) => !row.chart || row.chart === activeChart);
    const accountNames = mapLedgerAccountNames(activeLedgerAccounts);
    for (const draft of draftRows) {
      draftMap.set(
        draft.transactionId,
        mapEntityDraftToUiDraft(
          draft,
          accountNames,
          activeChart,
          bankStatusByTransactionId.get(draft.transactionId) === 'booked' ? 'posted' : draft.workflowStatus,
        ),
      );
    }

    const baseTransactions = mapTransactions(
      transactionRows,
      virtualPostedTransactionIds,
    );
    const mergedTransactions = baseTransactions;
    const bankAccountNumberByTransactionId = Object.fromEntries(
      (txQuery.data ?? []).flatMap((tx) => {
        const account = bankAccounts.find((candidate) => candidate.id === tx.accountId);
        return account?.defaultSkrAccountNumber ? [[tx.id, account.defaultSkrAccountNumber]] : [];
      }),
    );
    return {
      transactions: mergedTransactions,
      accounts: mapLedgerAccounts(activeLedgerAccounts),
      drafts: Array.from(draftMap.values()),
      chartFramework: activeChart,
      businessReportingProfile,
      bankAccountNumber: Object.values(bankAccountNumberByTransactionId).length === 1
        ? Object.values(bankAccountNumberByTransactionId)[0]
        : undefined,
      bankAccountNumberByTransactionId,
      seedVersion: `${txQuery.data?.length ?? 0}:${draftRows.length}:${ledgerAccounts.length}:${activeChart}:${businessReportingProfile?.legalForm ?? 'unknown'}:${businessReportingProfile?.profitDetermination ?? 'unknown'}:${businessReportingProfile?.fiscalYearStart ?? 'unknown'}:${Object.values(bankAccountNumberByTransactionId).join(',')}`,
    };
  }, [txQuery.data, draftQuery.data, ledgerAccounts, activeChart, bankAccounts, businessReportingProfile]);

  const accountNames = React.useMemo(
    () => mapLedgerAccountNames(ledgerAccounts.filter((row) => !row.chart || row.chart === activeChart)),
    [ledgerAccounts, activeChart],
  );

  const adapterTransactionsRef = React.useRef<ProUiTransaction[]>([]);
  const adapterDraftsRef = React.useRef<Map<string, ProUiBookingDraft>>(new Map());
  React.useEffect(() => {
    adapterTransactionsRef.current = structuredClone(seed.transactions ?? []);
    adapterDraftsRef.current = new Map(
      (seed.drafts ?? []).map((draft) => [draft.transactionId, structuredClone(draft)]),
    );
  }, [seed.seedVersion, seed.transactions, seed.drafts]);

  const invalidateProQueries = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['pro-accounting', 'transactions'] }),
      queryClient.invalidateQueries({ queryKey: ['pro-accounting', 'drafts'] }),
      queryClient.invalidateQueries({ queryKey: ['pro-reports'] }),
    ]);
  }, [queryClient]);

  const runMutation = React.useCallback(async <T,>(mutation: () => Promise<T>): Promise<T> => {
    setAdapterBusy(true);
    setAdapterError(null);
    try {
      const result = await mutation();
      await invalidateProQueries();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Aktion konnte nicht gespeichert werden.';
      setAdapterError(message);
      throw error;
    } finally {
      setAdapterBusy(false);
    }
  }, [invalidateProQueries]);

  const handleImportSkr = async () => {
    setImportMessage(null);
    setImportFailed(false);
    try {
      await importSkr.mutateAsync({ preferredSource: 'auto' });
      setImportMessage('Kontenrahmen erfolgreich importiert.');
    } catch (error) {
      setImportFailed(true);
      setImportMessage(error instanceof Error ? error.message : 'Kontenrahmen konnte nicht importiert werden.');
    }
  };

  const dataAdapter = React.useMemo<ProAccountingDataAdapter>(() => {
    let activeReportFilters: ReportFilterState | undefined;
    const setTxWorkflowStatus = (transactionId: string, workflowStatus: ProUiTransaction['workflowStatus']) => {
      const idx = adapterTransactionsRef.current.findIndex((tx) => tx.id === transactionId);
      if (idx === -1) return;
      adapterTransactionsRef.current[idx] = {
        ...adapterTransactionsRef.current[idx],
        workflowStatus,
      };
    };
    return {
      hydrate(seedData) {
        adapterTransactionsRef.current = structuredClone(seedData.transactions ?? []);
        adapterDraftsRef.current = new Map(
          (seedData.drafts ?? []).map((draft) => [draft.transactionId, structuredClone(draft)]),
        );
      },
      listTransactions() {
        return structuredClone(adapterTransactionsRef.current);
      },
      listBookingDrafts() {
        return structuredClone(Array.from(adapterDraftsRef.current.values()));
      },
      getTransactionById(id) {
        const tx = adapterTransactionsRef.current.find((row) => row.id === id);
        return tx ? structuredClone(tx) : undefined;
      },
      getBookingDraftByTransactionId(transactionId) {
        const draft = adapterDraftsRef.current.get(transactionId);
        return draft ? structuredClone(draft) : undefined;
      },
      async saveDraft(draft) {
        return runMutation(async () => {
          const saved = await ipc.pro.saveDraft({ draft: mapUiDraftToEntityDraft(draft) });
          const resolvedDraft = mapEntityDraftToUiDraft(saved, accountNames, activeChart);
          adapterDraftsRef.current.set(draft.transactionId, resolvedDraft);
          return structuredClone(resolvedDraft);
        });
      },
      async dispatchBookingAction(transactionId, action, options) {
        const existing = adapterDraftsRef.current.get(transactionId);
        if (!existing) throw new Error('Draft not found');
        return runMutation(async () => {
          const dispatched = await ipc.pro.dispatchDraftAction({
            transactionId,
            action,
            rejectReason: options?.rejectReason,
          });
          let resolvedDraft = mapEntityDraftToUiDraft(dispatched, accountNames, activeChart);

          if (action === 'post') {
            const postResult = await ipc.pro.postDraft({
              draftId: resolvedDraft.id,
            });
            const hasBlocking = postResult.issues.some((issue) => issue.blocking);
            if (!hasBlocking) {
              resolvedDraft = { ...resolvedDraft, workflowStatus: 'posted' };
            } else {
              resolvedDraft = {
                ...resolvedDraft,
                workflowStatus: 'incomplete',
                validationIssues: postResult.issues.map((issue) => ({
                  id: issue.id,
                  code: issue.code as any,
                  severity: issue.severity,
                  message: issue.message,
                  fieldPath: issue.fieldPath,
                  blocking: issue.blocking,
                  source: issue.source,
                })),
              };
            }
          } else if (action === 'reverse') {
            const entries = await ipc.pro.listJournalEntries({ limit: 500, offset: 0 });
            const entry = entries.find((row) => row.sourceDraftId === resolvedDraft.id && row.status === 'posted');
            if (entry) {
              await ipc.pro.reverseJournalEntry({
                entryId: entry.id,
                reason: options?.rejectReason || 'Storno aus Pro Workspace',
              });
            }
          }

          const authoritative = await ipc.pro.getDraftByTransactionId({ transactionId });
          if (authoritative) resolvedDraft = mapEntityDraftToUiDraft(authoritative, accountNames, activeChart);
          adapterDraftsRef.current.set(transactionId, resolvedDraft);
          setTxWorkflowStatus(transactionId, resolvedDraft.workflowStatus);
          return structuredClone(resolvedDraft);
        });
      },
      listActivity(transactionId) {
        const draft = adapterDraftsRef.current.get(transactionId);
        return structuredClone(draft?.activity ?? []);
      },
      async getSusaReport(filters) {
        activeReportFilters = filters;
        const range = reportPeriodRange(filters);
        const report = await ipc.pro.getSusaReport({
          asOfDate: filters.asOfDate,
          from: range.from,
          to: range.to,
        });
        const accounts = await ipc.pro.listLedgerAccounts({ chart: report.chart ?? filters.chart, limit: 10_000 });
        return mapSusaReport(report, accounts);
      },
      async getGuvReport(filters) {
        activeReportFilters = filters;
        const range = reportPeriodRange(filters);
        const report = await ipc.pro.getGuvReport(range);
        return mapGuvReport(report);
      },
      async getEurReport(_filters) {
        const report = await ipc.eur.getReport({ taxYear: 2025, ...NATIVE_EUR_2025_RANGE });
        return mapEurReport(report);
      },
      listEurCashItems() {
        return ipc.eur.listItems({ taxYear: 2025, ...NATIVE_EUR_2025_RANGE }).then((items) => items.map(mapNativeEurCashItem));
      },
      upsertEurClassification(input) {
        return runMutation(() => ipc.eur.upsertClassification({
          ...input,
          taxYear: 2025,
          reason: requireMutationReason(input.reason, 'EÜR-Klassifikation speichern'),
        }));
      },
      listReportSnapshots(reportType) {
        return ipc.pro.listReportSnapshots({ reportType }).then((rows) => rows.map((row) => ({
          ...row,
          args: row.args ?? {},
          payload: row.payload ?? null,
        })));
      },
      saveReportSnapshot(input) {
        return runMutation(() => ipc.pro.saveReportSnapshot(input)).then((row) => ({
          ...row,
          args: row.args ?? {},
          payload: row.payload ?? null,
        }));
      },
      getReportMappingHealth(args) {
        return ipc.pro.getReportMappingHealth(args ?? {});
      },
      listReportMappingPositions(args) {
        return ipc.pro.listReportMappingPositions(args);
      },
      upsertReportMappingOverride(input) {
        return runMutation(() => ipc.pro.upsertReportMappingOverride(input));
      },
      async getBwaReport(filters) {
        activeReportFilters = filters;
        const report = await runReportingReport('bwa01', reportPeriodRange(filters));
        return mapBwa01Report(report as ReportResult<Bwa01Report>);
      },
      async getManagementGuvReport(filters) {
        activeReportFilters = filters;
        const report = await runReportingReport('management-guv', reportPeriodRange(filters));
        return mapManagementGuvReport(report as ReportResult<ManagementGuvReport>);
      },
      async getHgbGuvReport(filters) {
        activeReportFilters = filters;
        const report = await runReportingReport('hgb-guv', reportPeriodRange(filters));
        return mapHgbGuvReport(report as ReportResult<HgbGuvReport>);
      },
      async getBalanceSheetPreview(filters) {
        activeReportFilters = filters;
        const report = await runReportingReport('hgb-bilanz', { to: filters.asOfDate });
        const accounts = await ipc.pro.listLedgerAccounts({ chart: filters.chart, limit: 10_000 });
        return mapHgbBilanzReport(report as ReportResult<HgbBilanzReport>, accounts, filters.chart);
      },
      async getReportDrilldownEntries(selection) {
        if (!selection.accountNumbers.length) return [];
        const filters = activeReportFilters;
        const range = selection.from || selection.to
          ? { from: selection.from, to: selection.to }
          : selection.reportType === 'bilanz'
            ? { to: filters?.asOfDate }
            : filters ? reportPeriodRange(filters) : {};
        const entries = await ipc.pro.listJournalEntries({
          ...range,
          accountNumbers: selection.accountNumbers,
          limit: 5000,
          offset: 0,
        });
        return mapReportDrilldownEntries(entries, selection, range);
      },
      listAssets() {
        return ipc.pro.listAssets();
      },
      upsertAsset(asset, reason) {
        return ipc.pro.upsertAsset({ asset, reason });
      },
      getDepreciationSchedule(assetId) {
        return ipc.pro.getDepreciationSchedule({ assetId }).then((rows) => rows
          .filter((row) => row.status !== 'cancelled')
          .map((row) => ({ ...row, status: row.status as 'planned' | 'posted' })));
      },
      runDepreciation(args) {
        return ipc.pro.runDepreciation(args).then((result) => {
          if (result.scheduleEntry.status === 'cancelled') {
            throw new Error('Die Abschreibung wurde storniert und nicht gebucht.');
          }
          return {
            ...result,
            scheduleEntry: {
              ...result.scheduleEntry,
              status: result.scheduleEntry.status === 'posted' ? 'posted' : 'planned',
            },
          };
        });
      },
      disposeAsset(args) {
        return ipc.pro.disposeAsset(args);
      },
      listDatevExports(limit?: number) {
        return ipc.pro.listDatevExports({ limit });
      },
      exportDatevBuchungsstapel(args: DatevExportArgs) {
        return runMutation(() => ipc.pro.exportDatevBuchungsstapel(args));
      },
      listOpenItems() {
        return ipc.pro.listOpenItems();
      },
      async listBankTransactions(): Promise<OposBankTransaction[]> {
        const transactions = await ipc.pro.listBankTransactions();
        return transactions.flatMap((transaction) => {
          const bankAccountNumber = bankAccounts.find((account) => account.id === transaction.accountId)?.defaultSkrAccountNumber;
          return bankAccountNumber ? [{ ...transaction, bankAccountNumber }] : [];
        });
      },
      allocateOpenItemPayment(input: OpenItemPaymentInput) {
        return ipc.pro.allocateOpenItemPayment({ payment: input });
      },
      allocateRemainingOpenItemPayment(paymentId, allocations, allocationEventId, reason) {
        return ipc.pro.allocateRemainingPayment({ paymentId, allocations, allocationEventId, reason });
      },
      listVendors() {
        return ipc.pro.listVendors();
      },
      upsertVendor(vendor, reason) {
        return ipc.pro.upsertVendor({ vendor: { ...vendor, tenantId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, reason });
      },
      listIncomingInvoices() {
        return ipc.pro.listIncomingInvoices();
      },
      upsertIncomingInvoice(invoice: IncomingInvoiceEntity, reason) {
        return ipc.pro.upsertIncomingInvoice({ invoice, reason });
      },
      previewIncomingInvoiceAccounting(invoiceId) {
        return ipc.pro.previewIncomingInvoiceAccounting({ invoiceId });
      },
      postIncomingInvoiceAccounting(invoiceId, options) {
        return ipc.pro.postIncomingInvoiceAccounting({ invoiceId, reason: options.reason, softLockOverride: options.softLockOverride, overrideReason: options.overrideReason });
      },
    };
  }, [accountNames, activeChart, bankAccounts, invalidateProQueries, runMutation]);

  if (txQuery.isLoading || draftQuery.isLoading || policyQuery.isLoading) {
    return (
      <div className="bg-surface rounded-2xl p-8 min-h-full shadow-sm text-sm text-muted">
        Lade Pro-Buchhaltungsdaten…
      </div>
    );
  }

  if (txQuery.isError || draftQuery.isError || policyQuery.isError || ledgerStatsError || ledgerAccountsError || bankAccountsError) {
    return (
      <div className="bg-surface rounded-2xl p-8 min-h-full shadow-sm text-sm text-error" role="alert">
        Pro-Buchhaltungsdaten konnten nicht geladen werden: {String(txQuery.error ?? draftQuery.error ?? policyQuery.error ?? ledgerStatsLoadError ?? ledgerAccountsLoadError ?? bankAccountsLoadError)}
      </div>
    );
  }

  if ((ledgerStats?.total ?? 0) === 0) {
    return (
      <div className="bg-surface rounded-2xl p-8 min-h-full shadow-sm">
        <h2 className="text-xl font-black text-foreground">Pro Kontenrahmen fehlt</h2>
        <p className="mt-2 text-sm text-muted">
          Bitte laden Sie zuerst den SKR03/04 Kontenrahmen für die Pro-Buchhaltung.
        </p>
        {importMessage && <div className={`mt-3 text-sm ${importFailed ? 'text-error' : 'text-success'}`} role={importFailed ? 'alert' : 'status'} aria-live={importFailed ? 'assertive' : 'polite'}>{importMessage}</div>}
        <Button
          variant="dark"
          size="md"
          onClick={() => void handleImportSkr()}
          disabled={importSkr.isPending}
          aria-busy={importSkr.isPending}
          className="mt-5"
        >
          {importSkr.isPending ? 'Import läuft…' : 'SKR03/04 importieren'}
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-2xl px-6 pt-5 pb-0 h-full flex flex-col shadow-sm">
      <div className="mb-3 flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-xl font-black text-foreground leading-tight">Pro Buchhaltung</h2>
          <p className="text-xs text-muted mt-0.5">Doppelte Buchführung, Kontenrahmen und Berichte.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setShowRulesModal(true)}>
          <Settings2 size={14} />
          Regeln
        </Button>
      </div>



      {adapterBusy && <div className="px-1 pb-2 text-xs text-muted" aria-live="polite">Speichere Änderung…</div>}
      {adapterError && (
        <div className="mb-2 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert" aria-live="assertive">
          {adapterError}
        </div>
      )}
      <div className="flex-1 min-h-0 rounded-t-2xl border border-b-0 border-border overflow-hidden">
        <ProAccountingWorkspace
          seed={seed}
          dataAdapter={dataAdapter}
          busy={adapterBusy}
          onPersistEntry={async ({ transaction, draft }) => {
            await runMutation(async () => {
              await ipc.pro.saveDraft({
                draft: mapUiDraftToEntityDraft({
                  ...draft,
                  transactionId: transaction.id,
                }),
              });
            });
          }}
        />
      </div>
      {showRulesModal && (
        <ProAccountRulesModal
          chartFramework={(seed.chartFramework ?? 'SKR03') as 'SKR03' | 'SKR04'}
          onClose={() => setShowRulesModal(false)}
          onRulesChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ['pro-accounting', 'transactions'] });
          }}
        />
      )}
    </div>
  );
};
