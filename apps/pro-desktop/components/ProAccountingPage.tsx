import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { Button } from '@billme/ui';
import {
  ProAccountingWorkspace,
  type ProAccountingDataAdapter,
  type ProAccountingSeed,
  type Transaction as ProUiTransaction,
  type Account as ProUiAccount,
  type BookingDraft as ProUiBookingDraft,
} from '@billme/accounting-ui-pro';
import { ipc } from '../ipc/client';
import { useImportSkrMutation, useProLedgerAccountsQuery, useProLedgerStatsQuery } from '../hooks/useProLedger';
import type { IpcArgs, IpcResult } from '../ipc/contract';
import { ProAccountRulesModal } from './ProAccountRulesModal';
import {
  mapBalanceSheetPreview,
  mapGuvReport,
  mapReportDrilldownEntries,
  mapSusaReport,
} from './reportAdapters';

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

const mapTransactions = (
  rows: Awaited<ReturnType<typeof ipc.pro.listBankTransactions>>,
): ProUiTransaction[] => {
  return rows.map((row) => {
    const workflowStatus: ProUiTransaction['workflowStatus'] =
      row.linkedInvoiceId
        ? 'posted'
        : row.status === 'booked'
          ? 'suggested'
          : 'imported';
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
    };
  });
};

const mapEntityDraftToUiDraft = (
  draft: NonNullable<IpcResult<'pro:getDraftByTransactionId'>>,
): ProUiBookingDraft => {
  return {
    id: draft.id,
    transactionId: draft.transactionId,
    workflowStatus: draft.workflowStatus,
    documentDate: draft.documentDate,
    postingDate: draft.postingDate,
    serviceDate: draft.documentDate,
    bookingText: draft.bookingText,
    externalReference: draft.reference,
    chartFramework: 'SKR03',
    lines: draft.lines.map((line) => {
      const hasDebit = Number(line.debitAmount || 0) > 0;
      const amount = hasDebit ? Number(line.debitAmount || 0) : Number(line.creditAmount || 0);
      return {
        id: line.id,
        accountId: line.accountNumber,
        accountName: line.accountNumber,
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
  const { data: ledgerStats, isError: ledgerStatsError, error: ledgerStatsLoadError } = useProLedgerStatsQuery();
  const { data: ledgerAccounts = [], isError: ledgerAccountsError, error: ledgerAccountsLoadError } = useProLedgerAccountsQuery({
    chart: 'SKR03',
    limit: 3000,
  });
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
    for (const draft of draftRows) {
      draftMap.set(draft.transactionId, mapEntityDraftToUiDraft(draft));
    }

    const baseTransactions = mapTransactions(txQuery.data ?? []);
    const mergedTransactions = baseTransactions;
    const chartFramework =
      (ledgerStats?.byChart.SKR03 ?? 0) > 0 ? 'SKR03' : 'SKR04';
    return {
      transactions: mergedTransactions,
      accounts: mapLedgerAccounts(ledgerAccounts),
      drafts: Array.from(draftMap.values()),
      chartFramework: chartFramework as 'SKR03' | 'SKR04',
      seedVersion: `${txQuery.data?.length ?? 0}:${draftRows.length}:${ledgerAccounts.length}:${chartFramework}`,
    };
  }, [txQuery.data, draftQuery.data, ledgerAccounts, ledgerStats?.byChart.SKR03]);

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
          const resolvedDraft = mapEntityDraftToUiDraft(saved);
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
          let resolvedDraft = mapEntityDraftToUiDraft(dispatched);

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
          if (authoritative) resolvedDraft = mapEntityDraftToUiDraft(authoritative);
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
        const [report, accounts] = await Promise.all([
          ipc.pro.getSusaReport({ asOfDate: filters.asOfDate }),
          ipc.pro.listLedgerAccounts({ chart: filters.chart, limit: 10_000 }),
        ]);
        return mapSusaReport(report, accounts);
      },
      async getGuvReport(filters) {
        const report = await ipc.pro.getGuvReport({
          from: filters.periodFrom ? `${filters.periodFrom}-01` : undefined,
          to: filters.periodTo ? `${filters.periodTo}-31` : undefined,
        });
        return mapGuvReport(report);
      },
      async getBalanceSheetPreview(filters) {
        const [report, accounts] = await Promise.all([
          ipc.pro.getBilanzReport({ asOfDate: filters.asOfDate }),
          ipc.pro.listLedgerAccounts({ chart: filters.chart, limit: 10_000 }),
        ]);
        return mapBalanceSheetPreview(report, accounts);
      },
      async getReportDrilldownEntries(selection) {
        if (!selection.accountNumbers.length) return [];
        const entries = await ipc.pro.listJournalEntries({
          accountNumbers: selection.accountNumbers,
          limit: 5000,
          offset: 0,
        });
        return mapReportDrilldownEntries(entries, selection);
      },
      listAssets() {
        return ipc.pro.listAssets();
      },
      upsertAsset(asset, reason) {
        return ipc.pro.upsertAsset({ asset, reason });
      },
      getDepreciationSchedule(assetId) {
        return ipc.pro.getDepreciationSchedule({ assetId });
      },
      runDepreciation(args) {
        return ipc.pro.runDepreciation(args);
      },
      disposeAsset(args) {
        return ipc.pro.disposeAsset(args);
      },
    };
  }, [invalidateProQueries, runMutation]);

  if (txQuery.isLoading || draftQuery.isLoading) {
    return (
      <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm text-sm text-gray-600">
        Lade Pro-Buchhaltungsdaten…
      </div>
    );
  }

  if (txQuery.isError || draftQuery.isError || ledgerStatsError || ledgerAccountsError) {
    return (
      <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm text-sm text-red-700" role="alert">
        Pro-Buchhaltungsdaten konnten nicht geladen werden: {String(txQuery.error ?? draftQuery.error ?? ledgerStatsLoadError ?? ledgerAccountsLoadError)}
      </div>
    );
  }

  if ((ledgerStats?.total ?? 0) === 0) {
    return (
      <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm">
        <h2 className="text-xl font-black text-gray-900">Pro Kontenrahmen fehlt</h2>
        <p className="mt-2 text-sm text-gray-600">
          Bitte laden Sie zuerst den SKR03/04 Kontenrahmen für die Pro-Buchhaltung.
        </p>
        {importMessage && <div className={`mt-3 text-sm ${importFailed ? 'text-error' : 'text-success'}`} role={importFailed ? 'alert' : 'status'} aria-live={importFailed ? 'assertive' : 'polite'}>{importMessage}</div>}
        <button
          onClick={() => void handleImportSkr()}
          disabled={importSkr.isPending}
          aria-busy={importSkr.isPending}
          className="mt-5 px-5 py-2.5 rounded-xl bg-black text-white text-sm font-semibold disabled:opacity-60"
        >
          {importSkr.isPending ? 'Import läuft…' : 'SKR03/04 importieren'}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl px-6 pt-5 pb-0 h-full flex flex-col shadow-sm">
      <div className="mb-3 flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-xl font-black text-gray-900 leading-tight">Pro Buchhaltung</h2>
          <p className="text-xs text-gray-500 mt-0.5">Doppelte Buchführung, Kontenrahmen und Berichte.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setShowRulesModal(true)}>
          <Settings2 size={14} />
          Regeln
        </Button>
      </div>



      {adapterBusy && <div className="px-1 pb-2 text-xs text-gray-500" aria-live="polite">Speichere Änderung…</div>}
      {adapterError && (
        <div className="mb-2 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert" aria-live="assertive">
          {adapterError}
        </div>
      )}
      <div className="flex-1 min-h-0 rounded-t-2xl border border-b-0 border-gray-200 overflow-hidden">
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
