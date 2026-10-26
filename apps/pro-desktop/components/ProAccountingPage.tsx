import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { Button, Card, PageHeader } from '@billme/ui';
import {
  ProAccountingWorkspace,
  userFacingReference,
  NATIVE_EUR_2025_RANGE,
  reportDateRange,
  type GuvReport,
  type ReportFilterState,
  type ProAccountingDataAdapter,
  type ProAccountingSeed,
  type Transaction as ProUiTransaction,
  type Account as ProUiAccount,
  type BookingDraft as ProUiBookingDraft,
  type EurCashItem,
  type AccountingCommandInput,
  type AccountingSourceRun,
  type EurCashFact,
  type EurCashFactInput,
  type EurAnnexFact,
  type EurAnnexFactInput,
} from '@billme/accounting-ui-pro';
import { ipc } from '../ipc/client';
import { useAccountsQuery } from '../hooks/useAccounts';
import { useSettingsQuery } from '@billme/desktop-renderer/hooks/useSettings';
import { localIsoDate } from '@billme/desktop-utils';
import { accountingErrorSentence, accountingErrorText } from '@billme/accounting-shared';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from '@billme/server-core/services';
import { useImportSkrMutation, useProLedgerAccountsQuery, useProLedgerStatsQuery } from '../hooks/useProLedger';
import type { IpcArgs, IpcResult } from '@billme/desktop-contracts-pro/contract';
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
import {
  mapBwa01Report,
  mapEurReport,
  mapGuvReport,
  previousYearRange,
  withPreviousYear,
  mapHgbGuvReport,
  mapHgbBilanzReport,
  mapManagementGuvReport,
  mapReportDrilldownEntries,
  mapSusaReport,
} from './reportAdapters';

/** Every adapter call answers a known accounting error code with its German sentence (accountingErrorText); the code stays on `cause`. */
const withGermanErrors = <T extends object>(adapter: T): T => {
  const translate = (error: unknown): never => {
    const sentence = error instanceof Error ? accountingErrorSentence(error.message) : undefined;
    throw sentence ? new Error(sentence, { cause: error }) : error;
  };
  return Object.fromEntries(Object.entries(adapter).map(([key, value]) => [key, typeof value === 'function'
    ? (...args: unknown[]) => {
      try {
        const result = (value as (...input: unknown[]) => unknown)(...args);
        return result instanceof Promise ? result.catch(translate) : result;
      } catch (error) {
        return translate(error);
      }
    }
    : value])) as T;
};

const reportPeriodRange = (filters: ReportFilterState): { from?: string; to?: string } =>
  reportDateRange(filters);

/** Loads a GuV-like report for the filter's range and, with "Vergleich: Vorjahr", the same range one year earlier. */
const withComparison = async (filters: ReportFilterState, load: (range: { from?: string; to?: string }) => Promise<GuvReport>): Promise<GuvReport> => {
  const range = reportPeriodRange(filters);
  const current = await load(range);
  if (filters.compareMode !== 'prev_year' || !range.from || !range.to) return current;
  return withPreviousYear(current, await load(previousYearRange(range)));
};

const nativeEurRange = (taxYear: number) => taxYear === 2026
  ? { from: '2026-01-01', to: '2026-12-31', label: '2026' }
  : NATIVE_EUR_2025_RANGE;

const requireMutationReason = (reason: string, operation: string): string => {
  const normalized = reason.trim();
  if (!normalized) throw new Error(`${operation}: Audit-Grund erforderlich.`);
  return normalized;
};

type NativeEurListItem = IpcResult<'eur:listItems'>[number];

const mapNativeEurCashItem = (item: NativeEurListItem): EurCashItem => {
  if (item.classification && item.classification.taxYear !== 2025 && item.classification.taxYear !== 2026) {
    throw new Error(`EUR_UNSUPPORTED_TAX_YEAR:${item.classification.taxYear}`);
  }
  const classification = item.classification ? { ...item.classification } : undefined;
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
    kind: item.kind,
    splits: item.splits?.map((split) => ({ ...split, reason: split.reason ?? '' })),
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
  range: { from?: string; to?: string; asOfDate?: string },
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
  kind?: 'journal' | 'opening_balances' | 'parties';
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
  draftsByTransactionId: ReadonlyMap<string, NonNullable<IpcResult<'pro:getDraftByTransactionId'>>> = new Map(),
): ProUiTransaction[] => {
  return rows.map((row) => {
    // The persisted booking draft owns the workflow state and its validation
    // issues; without it a blocked draft looked like an untouched import.
    const draft = draftsByTransactionId.get(row.id);
    const workflowStatus: ProUiTransaction['workflowStatus'] =
      row.status === 'booked' || row.linkedInvoiceId ? 'posted' : draft?.workflowStatus ?? 'imported';
    // A transfer between own accounts has no receipt: the other bank statement is the evidence.
    const missingReceipt = !row.linkedInvoiceId && !row.receiptDocumentCount && !row.isTransfer;
    const draftIssues = draft?.validationIssues ?? [];
    const draftErrors = draftIssues.filter((issue) => issue.severity === 'error').length;
    const draftWarnings = draftIssues.filter((issue) => issue.severity === 'warning').length;

    return {
      id: row.id,
      linkedInvoiceId: row.linkedInvoiceId,
      date: row.date,
      payee: row.counterparty || 'Unbekannt',
      description: row.purpose || 'Importierte Transaktion',
      amount: Number(row.amount || 0),
      currency: 'EUR',
      workflowStatus,
      // The fallback layer is only the chart's first expense/revenue account, not a proposal.
      suggestion: row.suggestionLayer === 'fallback' ? undefined : row.suggestedAccountNumber,
      suggestionConfidence: row.suggestionLayer === 'fallback' ? undefined : row.suggestionConfidence,
      suggestionLayer: row.suggestionLayer,
      hasReceipt: !missingReceipt,
      issueCounts: {
        errors: draftErrors,
        warnings: draftWarnings + (missingReceipt ? 1 : 0),
        infos: draftIssues.length - draftErrors - draftWarnings,
      },
      flags: missingReceipt ? ['missing_receipt'] : [],
      ...(draft?.exceptionCase ? { exceptionCase: draft.exceptionCase } : {}),
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
    ruleTrace: draft.ruleTrace,
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
    // A bank line's id is no Beleg; the journal and DATEV Belegfeld only carry real document numbers.
    reference: userFacingReference(draft.externalReference),
    period: (draft.postingDate ?? localIsoDate()).slice(0, 7),
    fiscalYear: Number((draft.postingDate ?? localIsoDate()).slice(0, 4)),
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

/**
 * Page title per accounting area: the label of the sidebar entry that opens it.
 * The subtitle is only set where that entry brings none of its own (Buchen,
 * Auswertungen, Offene Posten and Belege get theirs from the shell).
 */
const AREA_TITLES: Record<string, [string, string?]> = {
  inbox: ['Buchen'],
  reconciliation: ['Bankabgleich', 'Kontoumsätze mit Vorschlägen abgleichen.'],
  exceptions: ['Ausnahmen', 'Blockierte und auffällige Vorgänge klären.'],
  assets: ['Anlagen', 'Anlagevermögen, Abschreibung und Abgang.'],
  reports: ['Auswertungen'],
  opos: ['Offene Posten', 'Forderungen und Verbindlichkeiten'],
  special: ['Sonderbuchungen', 'Korrekturen und Abschlussbuchungen.'],
  receipts: ['Belege'],
};

/** `view` comes from the route (`/accounting?view=`) so the shell navigation can open an area directly. */
export const ProAccountingPage: React.FC<{ view?: unknown; onViewChange?: (view: string) => void; onOpenTaxFiling?: () => void; reportRequest?: { tab?: string; from?: string; to?: string } }> = ({ view, onViewChange, onOpenTaxFiling, reportRequest }) => {
  const queryClient = useQueryClient();
  const { data: settings } = useSettingsQuery();
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;
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
      new Map(draftRows.map((draft) => [draft.transactionId, draft])),
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
      queryClient.invalidateQueries({ queryKey: ['dashboard-month-result'] }),
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
      const message = error instanceof Error ? accountingErrorText(error.message) : 'Aktion konnte nicht gespeichert werden.';
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
    return withGermanErrors({
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
      async getLinkedInvoice(transactionId) {
        const transaction = adapterTransactionsRef.current.find((row) => row.id === transactionId);
        if (!transaction?.linkedInvoiceId) return null;
        const invoice = (await ipc.invoices.list()).find((row) => row.id === transaction.linkedInvoiceId);
        return invoice ? { id: invoice.id, number: invoice.number, client: invoice.client, date: invoice.date, dueDate: invoice.dueDate, amount: invoice.amount, status: invoice.status } : null;
      },
      getOpenRouterVlmConfig() {
        return ipc.pro.getOpenRouterVlmConfig();
      },
      analyzeTransactionDocument(input) {
        return ipc.pro.analyzeTransactionDocument(input);
      },
      async getJournalEntryById(id: string) {
        return ipc.pro.getJournalEntryById({ entryId: id });
      },
      async reverseJournalEntry(input) {
        const result = await ipc.pro.reverseJournalEntry(input);
        void queryClient.invalidateQueries({ queryKey: ['pro-accounting'] });
        return result;
      },
      async saveDraft(draft) {
        const drafts = adapterDraftsRef.current;
        return runMutation(async () => {
          const entity = mapUiDraftToEntityDraft(draft);
          // A changed Kontierung of a freigegebener draft goes back to review; the server owns "approved" and refuses it from a save.
          const saved = await ipc.pro.saveDraft({ draft: entity.workflowStatus === 'approved' ? { ...entity, workflowStatus: 'suggested' } : entity });
          const resolvedDraft = mapEntityDraftToUiDraft(saved, accountNames, activeChart);
          drafts.set(draft.transactionId, resolvedDraft);
          return structuredClone(resolvedDraft);
        });
      },
      async dispatchBookingAction(transactionId, action, options) {
        const pro = ipc.pro;
        const drafts = adapterDraftsRef.current;
        const transactions = adapterTransactionsRef.current;
        const existing = adapterDraftsRef.current.get(transactionId);
        if (!existing) throw new Error('Draft not found');
        return runMutation(async () => {
          // A Storno reverses the journal entry first; the server marks the draft reversed in the same transaction,
          // so a refused reversal (gesperrter Monat) never leaves a draft that says "storniert" over a live booking.
          const dispatched = action === 'reverse'
            ? await pro.getDraftByTransactionId({ transactionId })
            : await pro.dispatchDraftAction({
              transactionId,
              action,
              rejectReason: options?.rejectReason,
            });
          if (!dispatched) throw new Error('Draft not found');
          let resolvedDraft = mapEntityDraftToUiDraft(dispatched, accountNames, activeChart);

          if (action === 'post') {
            const postResult = await pro.postDraft({
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
            // Asked server-side by draft: a list of the latest 500 entries missed older postings silently.
            const entries = await pro.listJournalEntries({ sourceDraftId: resolvedDraft.id, limit: 50, offset: 0 });
            const entry = entries.find((row) => row.sourceDraftId === resolvedDraft.id && row.status === 'posted');
            if (!entry) throw new Error('Zu dieser Bankzeile gibt es keine gebuchte Journalbuchung mehr.');
            await pro.reverseJournalEntry({
              entryId: entry.id,
              reason: options?.rejectReason || 'Storno aus Pro Workspace',
            });
          }

          const authoritative = await pro.getDraftByTransactionId({ transactionId });
          if (authoritative) resolvedDraft = mapEntityDraftToUiDraft(authoritative, accountNames, activeChart);
          drafts.set(transactionId, resolvedDraft);
          if (transactions === adapterTransactionsRef.current) setTxWorkflowStatus(transactionId, resolvedDraft.workflowStatus);
          return structuredClone(resolvedDraft);
        });
      },
      async updateExceptionCase(transactionId, patch, actorName) {
        return runMutation(async () => {
          // Only what the server keeps; a cleared pause travels as '' (resolvedAt/By are the audit trail's).
          const sent = {
            ...(patch.state ? { state: patch.state } : {}),
            ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
            ...('snoozedUntil' in patch ? { snoozedUntil: patch.snoozedUntil ?? '' } : {}),
            ...(patch.resolutionNote !== undefined ? { resolutionNote: patch.resolutionNote } : {}),
          };
          const reason = patch.state === 'resolved' ? `Ausnahme gelöst: ${patch.resolutionNote || 'ohne Notiz'}`
            : patch.state === 'snoozed' ? `Ausnahme pausiert bis ${patch.snoozedUntil}`
              : patch.owner ? `Ausnahme zugewiesen an ${patch.owner}` : 'Ausnahme wieder geöffnet';
          const saved = await ipc.pro.updateExceptionCase({ transactionId, patch: sent, reason: `${reason} (${actorName})` });
          const idx = adapterTransactionsRef.current.findIndex((tx) => tx.id === transactionId);
          if (idx === -1) throw new Error('Bankzeile nicht gefunden.');
          adapterTransactionsRef.current[idx] = { ...adapterTransactionsRef.current[idx], exceptionCase: saved.exceptionCase };
          return structuredClone(adapterTransactionsRef.current[idx]);
        });
      },
      listActivity(transactionId) {
        const draft = adapterDraftsRef.current.get(transactionId);
        return structuredClone(draft?.activity ?? []);
      },
      async getSusaReport(filters) {
        const pro = ipc.pro;
        activeReportFilters = filters;
        const range = reportPeriodRange(filters);
        const report = await pro.getSusaReport({
          asOfDate: filters.asOfDate,
          from: range.from,
          to: range.to,
        });
        const accounts = await pro.listLedgerAccounts({ chart: report.chart ?? filters.chart, limit: 10_000 });
        return mapSusaReport(report, accounts);
      },
      async getGuvReport(filters) {
        activeReportFilters = filters;
        return withComparison(filters, async (range) => mapGuvReport(await ipc.pro.getGuvReport(range)));
      },
      async getEurReport(filters) {
        const year = Number(filters.asOfDate.slice(0, 4));
        const range = nativeEurRange(year);
        const report = await ipc.eur.getReport({ taxYear: year, ...range });
        return mapEurReport(report);
      },
      listEurCashItems(taxYear = 2025) {
        const range = nativeEurRange(taxYear);
        return ipc.eur.listItems({ taxYear, ...range }).then((items) => items.map(mapNativeEurCashItem));
      },
      upsertEurClassification(input) {
        return runMutation(() => ipc.eur.upsertClassification({
          ...input,
          taxYear: input.taxYear,
          reason: requireMutationReason(input.reason, 'EÜR-Klassifikation speichern'),
        }));
      },
      async postAccountingCommand(input: AccountingCommandInput) {
        return ipc.pro.postAccountingCommand({ ...input, chart: activeChart });
      },
      listAccountingSourceRuns(): Promise<AccountingSourceRun[]> {
        return ipc.pro.listAccountingSourceRuns();
      },
      listAccountingPeriods(year: number) {
        return ipc.pro.listAccountingPeriods({ year });
      },
      setAccountingPeriodStatus(input) {
        return runMutation(() => ipc.pro.setAccountingPeriodStatus({ ...input, reason: requireMutationReason(input.reason, 'Periodenstatus ändern') }));
      },
      async saveEurCashFact(input: EurCashFactInput): Promise<EurCashFact> {
        return ipc.eur.saveCashFact(input);
      },
      listEurCashFacts(taxYear: number): Promise<EurCashFact[]> {
        return ipc.eur.listCashFacts({ taxYear });
      },
      async saveEurAnnexFact(input: EurAnnexFactInput): Promise<EurAnnexFact> {
        return ipc.eur.saveAnnexFact(input);
      },
      listEurAnnexFacts(taxYear: number, annex?: string): Promise<EurAnnexFact[]> {
        return ipc.eur.listAnnexFacts({ taxYear, annex });
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
        return withComparison(filters, async (range) => mapBwa01Report(await runReportingReport('bwa01', range) as ReportResult<Bwa01Report>));
      },
      async getManagementGuvReport(filters) {
        activeReportFilters = filters;
        return withComparison(filters, async (range) => mapManagementGuvReport(await runReportingReport('management-guv', range) as ReportResult<ManagementGuvReport>));
      },
      async getHgbGuvReport(filters) {
        activeReportFilters = filters;
        return withComparison(filters, async (range) => mapHgbGuvReport(await runReportingReport('hgb-guv', range) as ReportResult<HgbGuvReport>));
      },
      async getBalanceSheetPreview(filters) {
        const pro = ipc.pro;
        activeReportFilters = filters;
        const report = await pro.getReportingReport({ kind: 'hgb-bilanz', asOfDate: filters.asOfDate });
        const accounts = await pro.listLedgerAccounts({ chart: filters.chart, limit: 10_000 });
        return mapHgbBilanzReport(report as unknown as ReportResult<HgbBilanzReport>, accounts, filters.chart);
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
      getAssetRegister(year) {
        return ipc.pro.getAssetRegister({ year });
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
      async disposeAsset({ saleCustomerId, ...args }) {
        if (!saleCustomerId) return ipc.pro.disposeAsset(args);
        // A sale to a customer goes through the normal invoice path: a draft „Verkauf Anlage …“ that books proceeds,
        // VAT and the open item once it is issued; the disposal itself only takes the book value off.
        const settings = settingsRef.current;
        if (!settings) throw new Error('Einstellungen sind noch nicht geladen. Bitte erneut versuchen.');
        const [client, asset] = await Promise.all([
          ipc.clients.list().then((rows) => rows.find((row) => row.id === saleCustomerId)),
          ipc.pro.listAssets().then((rows) => rows.find((row) => row.id === args.assetId)),
        ]);
        if (!client || !asset) throw new Error(client ? 'Die Anlage wurde nicht gefunden.' : 'Der gewählte Kunde wurde nicht gefunden.');
        const reservation = await ipc.numbers.reserve({ kind: 'invoice' });
        const items = [{ kind: 'item' as const, description: `Verkauf Anlage ${asset.assetNumber} ${asset.name}`.trim(), quantity: 1, price: args.proceeds, total: args.proceeds, taxRate: args.taxRate }];
        const taxMode = resolveInvoiceTaxMode(undefined, settings);
        const taxMeta = { assetSaleAssetId: args.assetId };
        const taxSnapshot = calculateInvoiceTaxSnapshot({ items, taxMode, taxMeta }, settings);
        const due = new Date(`${args.disposalDate}T12:00:00`);
        due.setDate(due.getDate() + (settings.legal?.paymentTermsDays ?? 14));
        const invoice = await ipc.invoices.upsert({
          reason: args.reason,
          invoice: {
            id: crypto.randomUUID(),
            number: reservation.number,
            numberReservationId: reservation.reservationId,
            clientId: client.id,
            clientNumber: client.customerNumber,
            client: client.company || client.contactPerson,
            clientEmail: client.email,
            clientAddress: client.address,
            date: args.disposalDate,
            dueDate: localIsoDate(due),
            amount: taxSnapshot.grossAmount,
            status: 'draft',
            items,
            payments: [],
            history: [],
            taxMode,
            taxMeta,
            taxSnapshot,
          },
        });
        try {
          const result = await ipc.pro.disposeAsset({ ...args, saleInvoiceId: invoice.id });
          void queryClient.invalidateQueries({ queryKey: ['invoices'] });
          return { ...result, saleInvoiceNumber: invoice.number };
        } catch (error) {
          // Without the disposal the draft would sell an asset that is still on the books.
          await ipc.invoices.delete({ id: invoice.id, reason: 'Anlagenabgang nicht gebucht' }).catch(() => undefined);
          throw error;
        }
      },
      async listCustomers() {
        return (await ipc.clients.list()).map((row) => ({ id: row.id, name: row.company || row.contactPerson }));
      },
      listDatevExports(limit?: number) {
        return ipc.pro.listDatevExports({ limit });
      },
      exportDatevBuchungsstapel(args: DatevExportArgs) {
        return runMutation(() => ipc.pro.exportDatevBuchungsstapel(args));
      },
      exportAuditPackage(args: { from: string; to: string; includeDocuments: boolean }) {
        return runMutation(() => ipc.tax.auditExportPackage(args));
      },
      exportProcedureDocumentation() {
        return ipc.pro.exportProcedureDocumentation();
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
      listOpenItemPayments() {
        return ipc.pro.listOpenItemPayments();
      },
      reverseOpenItemPayment(paymentId, reason) {
        return ipc.pro.reverseOpenItemPayment({ paymentId, reason });
      },
      reallocateOpenItemPayment(paymentId, input) {
        return ipc.pro.reallocateOpenItemPayment({ paymentId, ...input });
      },
      postManualJournalEntry(input) {
        return ipc.pro.postManualJournalEntry(input);
      },
      importJournal(input) {
        return ipc.pro.importJournal(input);
      },
      getBankLedgerReconciliation() {
        return ipc.pro.getBankLedgerReconciliation();
      },
      getVatSummary(range) {
        return ipc.pro.getVatSummary(range);
      },
      async prepareTaxExport(input) {
        const result = await ipc.pro.prepareTaxExport({ kind: input.kind, period: input.period, year: input.year, reason: input.reason, idempotencyKey: input.idempotencyKey ?? `tax:${input.kind}:${input.period}` });
        return { artifact: result.artifact as never, run: result.run as never, replayed: result.replayed };
      },
      async exportTaxArtifact(kind, id) {
        return JSON.stringify(await ipc.pro.getTaxExportArtifact({ kind, id }), null, 2);
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
      listIncomingInvoiceDocuments(invoiceId) {
        return ipc.pro.listIncomingInvoiceDocuments({ invoiceId });
      },
      listBankTransactionDocuments(transactionId) {
        return ipc.pro.listBankTransactionDocuments({ transactionId });
      },
      async uploadBankTransactionDocument(input) {
        const saved = await ipc.pro.uploadBankTransactionDocument(input);
        // The line is "mit Beleg" now: the inbox queue and the editor read it without a reload.
        const idx = adapterTransactionsRef.current.findIndex((tx) => tx.id === input.transactionId);
        const tx = adapterTransactionsRef.current[idx];
        if (tx && !tx.hasReceipt) {
          adapterTransactionsRef.current[idx] = {
            ...tx,
            hasReceipt: true,
            flags: tx.flags.filter((flag) => flag !== 'missing_receipt'),
            issueCounts: { ...tx.issueCounts, warnings: Math.max(0, tx.issueCounts.warnings - 1) },
          };
        }
        // The inbox reads the lines from the transactions query (receiptDocumentCount), not from this adapter copy.
        void queryClient.invalidateQueries({ queryKey: ['pro-accounting', 'transactions'] });
        return saved;
      },
      downloadBankTransactionDocument(documentId) {
        return ipc.pro.downloadBankTransactionDocument({ documentId });
      },
      uploadIncomingInvoiceDocument(input) {
        return ipc.pro.uploadIncomingInvoiceDocument(input);
      },
      downloadIncomingInvoiceDocument(documentId) {
        return ipc.pro.downloadIncomingInvoiceDocument({ documentId });
      },
      reviewIncomingInvoiceDocument(input) {
        return ipc.pro.reviewIncomingInvoiceDocument(input);
      },
      previewIncomingInvoiceAccounting(invoiceId) {
        return ipc.pro.previewIncomingInvoiceAccounting({ invoiceId });
      },
      postIncomingInvoiceAccounting(invoiceId, options) {
        return ipc.pro.postIncomingInvoiceAccounting({ invoiceId, reason: options.reason, softLockOverride: options.softLockOverride, overrideReason: options.overrideReason });
      },
      // Pro bank transactions share their id with the source transaction the invoice matcher reads.
      async findInvoiceMatches(transactionId) {
        const { suggestions } = await ipc.transactions.findMatches({ transactionId });
        return suggestions.map(({ invoice, confidence, matchReasons, amountDiff }) => ({
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          client: invoice.client,
          // What is still open, not the invoice gross: earlier part payments are already settled.
          amount: Math.round((invoice.amount - (invoice.payments ?? []).reduce((sum, payment) => sum + Number(payment.amount), 0)) * 100) / 100,
          dueDate: invoice.dueDate,
          confidence,
          matchReasons,
          amountDiff,
        }));
      },
      listAccountSuggestionRules() {
        return ipc.pro.listAccountSuggestionRules({ chart: activeChart });
      },
      getTransitOverview() {
        return ipc.pro.getTransitOverview();
      },
    });
  }, [accountNames, activeChart, bankAccounts, invalidateProQueries, queryClient, runMutation]);

  if (txQuery.isLoading || draftQuery.isLoading || policyQuery.isLoading) {
    return (
      <Card padding="lg" className="text-control text-muted">
        Lade Pro-Buchhaltungsdaten…
      </Card>
    );
  }

  if (txQuery.isError || draftQuery.isError || policyQuery.isError || ledgerStatsError || ledgerAccountsError || bankAccountsError) {
    return (
      <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert">
        Pro-Buchhaltungsdaten konnten nicht geladen werden: {String(txQuery.error ?? draftQuery.error ?? policyQuery.error ?? ledgerStatsLoadError ?? ledgerAccountsLoadError ?? bankAccountsLoadError)}
      </div>
    );
  }

  if ((ledgerStats?.total ?? 0) === 0) {
    return (
      <Card padding="lg">
        <h2 className="text-section text-foreground">Pro Kontenrahmen fehlt</h2>
        <p className="mt-1 text-control text-muted">
          Bitte laden Sie zuerst den SKR03/04 Kontenrahmen für die Pro-Buchhaltung.
        </p>
        {importMessage && <div className={`mt-3 text-control ${importFailed ? 'text-error-text' : 'text-success-text'}`} role={importFailed ? 'alert' : 'status'} aria-live={importFailed ? 'assertive' : 'polite'}>{importMessage}</div>}
        <Button
          onClick={() => void handleImportSkr()}
          disabled={importSkr.isPending}
          aria-busy={importSkr.isPending}
          className="mt-4"
        >
          {importSkr.isPending ? 'Import läuft…' : 'SKR03/04 importieren'}
        </Button>
      </Card>
    );
  }

  const [areaTitle, areaSubtitle] = AREA_TITLES[String(view)] ?? AREA_TITLES.inbox;

  return (
    <div className="flex flex-col">
      <PageHeader
        title={areaTitle}
        description={areaSubtitle}
        actions={(view === 'inbox' || view === 'reconciliation' || view === undefined) ? (
          <Button variant="secondary" onClick={() => { window.location.hash = '#/settings?section=rules'; }}>
            <Settings2 size={16} aria-hidden="true" />
            Regeln
          </Button>
        ) : undefined}
      />

      {adapterBusy && <div className="pb-2 text-caption text-muted" aria-live="polite">Speichere Änderung…</div>}
      {adapterError && (
        <div className="mb-3 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">
          {adapterError}
        </div>
      )}
      {/* Every area lays its own cards on the ground and scrolls with the page. */}
      <div className="min-w-0">
        <ProAccountingWorkspace
          view={view}
          onViewChange={onViewChange}
          onOpenTaxFiling={onOpenTaxFiling}
          reportRequest={reportRequest}
          onManageRules={(transactionId) => { window.location.hash = `#/settings?section=rules${transactionId ? `&ruleFrom=${encodeURIComponent(transactionId)}` : ''}`; }}
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
    </div>
  );
};
