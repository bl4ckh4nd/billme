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
  const { data: ledgerStats } = useProLedgerStatsQuery();
  const { data: ledgerAccounts = [] } = useProLedgerAccountsQuery({
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

  const invalidateProQueries = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['pro-accounting', 'transactions'] });
    void queryClient.invalidateQueries({ queryKey: ['pro-accounting', 'drafts'] });
    void queryClient.invalidateQueries({ queryKey: ['pro-reports'] });
  }, [queryClient]);

  const dataAdapter = React.useMemo<ProAccountingDataAdapter>(() => {
    const setTxWorkflowStatus = (transactionId: string, workflowStatus: ProUiTransaction['workflowStatus']) => {
      const idx = adapterTransactionsRef.current.findIndex((tx) => tx.id === transactionId);
      if (idx === -1) return;
      adapterTransactionsRef.current[idx] = {
        ...adapterTransactionsRef.current[idx],
        workflowStatus,
      };
    };
    const patchExceptionCase = (
      transactionId: string,
      patch: Partial<NonNullable<ProUiTransaction['exceptionCase']>>,
    ): ProUiTransaction => {
      const idx = adapterTransactionsRef.current.findIndex((tx) => tx.id === transactionId);
      if (idx === -1) throw new Error('Transaction not found');
      const tx = adapterTransactionsRef.current[idx];
      const next = {
        ...tx,
        exceptionCase: {
          state: 'open' as const,
          ...(tx.exceptionCase ?? {}),
          ...patch,
        },
      };
      adapterTransactionsRef.current[idx] = next;
      return structuredClone(next);
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
      saveDraft(draft) {
        adapterDraftsRef.current.set(draft.transactionId, structuredClone(draft));
        void ipc.pro.saveDraft({ draft: mapUiDraftToEntityDraft(draft) }).then(() => {
          invalidateProQueries();
        });
        return structuredClone(draft);
      },
      dispatchBookingAction(transactionId, action, options) {
        const existing = adapterDraftsRef.current.get(transactionId);
        if (!existing) throw new Error('Draft not found');
        const next = structuredClone(existing);

        if (action === 'save_draft') next.workflowStatus = 'suggested';
        else if (action === 'submit_for_review') next.workflowStatus = 'pending_approval';
        else if (action === 'approve') next.workflowStatus = 'approved';
        else if (action === 'reject' || action === 'request_receipt') next.workflowStatus = 'incomplete';
        else if (action === 'post') next.workflowStatus = 'approved';
        else if (action === 'reverse') next.workflowStatus = 'reversed';
        else if (action === 'create_correction') next.workflowStatus = 'corrected';

        adapterDraftsRef.current.set(transactionId, next);
        setTxWorkflowStatus(transactionId, next.workflowStatus);

        void (async () => {
          const dispatched = await ipc.pro.dispatchDraftAction({
            transactionId,
            action,
            rejectReason: options?.rejectReason,
          });
          let resolvedDraft = mapEntityDraftToUiDraft(dispatched);

          if (action === 'post') {
            const postResult = await ipc.pro.postDraft({
              draftId: resolvedDraft.id,
              actorRole: options?.role ?? 'bookkeeper',
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
                actorRole: options?.role ?? 'bookkeeper',
              });
            }
          }

          adapterDraftsRef.current.set(transactionId, resolvedDraft);
          setTxWorkflowStatus(transactionId, resolvedDraft.workflowStatus);
          invalidateProQueries();
        })();

        return structuredClone(next);
      },
      listActivity(transactionId) {
        const draft = adapterDraftsRef.current.get(transactionId);
        return structuredClone(draft?.activity ?? []);
      },
      updateExceptionCase(transactionId, patch) {
        return patchExceptionCase(transactionId, patch);
      },
      assignExceptionOwner(transactionId, owner) {
        return patchExceptionCase(transactionId, { owner, state: 'open' });
      },
      snoozeException(transactionId, snoozedUntil, _actorName, note) {
        return patchExceptionCase(transactionId, { state: 'snoozed', snoozedUntil, resolutionNote: note });
      },
      resolveException(transactionId, resolutionNote, actorName) {
        return patchExceptionCase(
          transactionId,
          {
            state: 'resolved',
            resolutionNote,
            resolvedAt: new Date().toISOString(),
            resolvedBy: actorName,
          },
        );
      },
      reopenException(transactionId) {
        return patchExceptionCase(
          transactionId,
          { state: 'open', snoozedUntil: undefined, resolvedAt: undefined, resolvedBy: undefined },
        );
      },
      setTransactionReceiptStatus(transactionId, hasReceipt) {
        const idx = adapterTransactionsRef.current.findIndex((tx) => tx.id === transactionId);
        if (idx === -1) throw new Error('Transaction not found');
        const next = { ...adapterTransactionsRef.current[idx], hasReceipt };
        adapterTransactionsRef.current[idx] = next;
        return structuredClone(next);
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
  }, [invalidateProQueries]);

  if (txQuery.isLoading || draftQuery.isLoading) {
    return (
      <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm text-sm text-gray-600">
        Lade Pro-Buchhaltungsdaten…
      </div>
    );
  }

  if (txQuery.isError || draftQuery.isError) {
    return (
      <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm text-sm text-red-700">
        Pro-Buchhaltungsdaten konnten nicht geladen werden: {String(txQuery.error ?? draftQuery.error)}
      </div>
    );
  }

  if ((ledgerStats?.total ?? 0) === 0) {
    return (
      <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm">
        <h2 className="text-xl font-black text-gray-900">Pro Kontenrahmen fehlt</h2>
        <p className="mt-2 text-sm text-gray-600">
          Bitte laden Sie zuerst den SKR03/04 Kontenrahmen für die Pro-Buchhaltung.
        </p>
        <button
          onClick={() => void importSkr.mutateAsync({ preferredSource: 'auto' })}
          disabled={importSkr.isPending}
          className="mt-5 px-5 py-2.5 rounded-xl bg-black text-white text-sm font-semibold disabled:opacity-60"
        >
          {importSkr.isPending ? 'Import läuft…' : 'SKR03/04 importieren'}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-[2.5rem] px-6 pt-5 pb-0 h-full flex flex-col shadow-sm">
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



      <div className="flex-1 min-h-0 rounded-t-2xl border border-b-0 border-gray-200 overflow-hidden">
        <ProAccountingWorkspace
          seed={seed}
          dataAdapter={dataAdapter}
          onPersistEntry={async ({ transaction, draft }) => {
            await ipc.pro.saveDraft({
              draft: mapUiDraftToEntityDraft({
                ...draft,
                transactionId: transaction.id,
              }),
            });
            invalidateProQueries();
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
