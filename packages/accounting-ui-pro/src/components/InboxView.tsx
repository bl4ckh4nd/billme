import { useEffect, useMemo, useState } from 'react';
import {
  Inbox,
  CheckSquare,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { getQueueCounts, getStatusPresentation, InboxQueueKey, txMatchesQueue } from '../domain/selectors';
import { normalizeTaxCaseKey, TAX_CASE_OPTIONS, toLegacyTaxCode } from '../domain/taxCases';
import { getAllowedActions } from '../domain/workflow';
import { mockAccounts } from '../mocks/accounts';
import { permissionContextForRole } from '../mocks/users';
import {
  dispatchBookingAction,
  getBookingDraftByTransactionId,
  saveDraft,
} from '../services/mockBookingStore';
import AccountCombobox from './AccountCombobox';
import { getConfiguredBankAccountNumber } from './ReconciliationWorkbench';
import { Account, BookingAction, BookingDraft, Transaction, UserRole } from '../types';
import InboxQueueTabs from './InboxQueueTabs';
import IssueBadges from './IssueBadges';

interface InboxViewProps {
  role: UserRole;
  accounts?: Account[];
  bankAccountNumber?: string;
  bankAccountNumberByTransactionId?: Record<string, string>;
  transactions: Transaction[];
  onOpenTransaction: (transactionId: string) => void;
  onRefresh: () => void;
  forcedPreviewTransactionId?: string | null;
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);
}

function nextActionLabel(action: BookingAction | undefined) {
  switch (action) {
    case 'approve':
      return 'Freigeben';
    case 'post':
      return 'Buchen';
    case 'submit_for_review':
      return 'Einreichen';
    default:
      return 'Buchen';
  }
}

export default function InboxView({
  role,
  accounts,
  bankAccountNumber: configuredBankAccountNumber,
  bankAccountNumberByTransactionId,
  transactions,
  onOpenTransaction,
  onRefresh,
  forcedPreviewTransactionId,
}: InboxViewProps) {
  const accountOptions = accounts ?? mockAccounts;
  const [activeQueue, setActiveQueue] = useState<InboxQueueKey>('all');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchMessage, setBatchMessage] = useState<string>('');
  const [batchAccountSelection, setBatchAccountSelection] = useState<{ id: string; name: string } | null>(null);
  const [bookingTextEdits, setBookingTextEdits] = useState<Record<string, string>>({});
  const [notesEdits, setNotesEdits] = useState<Record<string, string>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const permissionCtx = permissionContextForRole(role);
  const bankAccountNumberForTransaction = (transactionId: string) =>
    bankAccountNumberByTransactionId?.[transactionId] ?? configuredBankAccountNumber;
  const queueCounts = useMemo(() => getQueueCounts(transactions), [transactions]);
  const filtered = useMemo(
    () => transactions.filter((tx) => txMatchesQueue(tx, activeQueue)),
    [transactions, activeQueue],
  );

  const previewTx = previewId ? filtered.find((tx) => tx.id === previewId) ?? null : null;
  const previewDraft = previewTx ? getBookingDraftByTransactionId(previewTx.id) : undefined;
  const previewBankAccountNumber = previewDraft
    ? getConfiguredBankAccountNumber(
        previewDraft,
        accounts ?? [],
        bankAccountNumberForTransaction(previewDraft.transactionId),
        accounts === undefined,
      )
    : undefined;
  const previewCounterLine = previewDraft && previewBankAccountNumber
    ? previewDraft.lines.find((line) => line.accountId !== previewBankAccountNumber)
    : undefined;
  const previewAccountEditable = !!previewDraft && !['posted', 'reversed'].includes(previewDraft.workflowStatus);

  const selectedSet = new Set(selectedIds);
  const allVisibleSelected = filtered.length > 0 && filtered.every((tx) => selectedSet.has(tx.id));

  useEffect(() => {
    if (!forcedPreviewTransactionId) return;
    setPreviewId(forcedPreviewTransactionId);
  }, [forcedPreviewTransactionId]);

  const toggleRowSelection = (txId: string) => {
    setSelectedIds((prev) => (prev.includes(txId) ? prev.filter((id) => id !== txId) : [...prev, txId]));
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const prevSet = new Set(prev);
      if (filtered.length > 0 && filtered.every((tx) => prevSet.has(tx.id))) {
        return prev.filter((id) => !filtered.some((tx) => tx.id === id));
      }
      const merged = new Set(prev);
      filtered.forEach((tx) => merged.add(tx.id));
      return Array.from(merged);
    });
  };

  const handleInlineAction = async (tx: Transaction) => {
    const draft = getBookingDraftByTransactionId(tx.id);
    if (!draft) return;
    const allowed = getAllowedActions(draft.workflowStatus, permissionCtx, draft.validationIssues);
    const primary = allowed.find((a) => ['approve', 'post', 'submit_for_review'].includes(a));
    if (!primary) {
      onOpenTransaction(tx.id);
      return;
    }
    try {
      await dispatchBookingAction(tx.id, primary, { role, actorName: role });
      onRefresh();
    } catch (error) {
      setBatchMessage(error instanceof Error ? error.message : 'Aktion konnte nicht gespeichert werden.');
    }
  };

  const runBatchAction = async (preferredAction: BookingAction) => {
    const ids = filtered.filter((tx) => selectedSet.has(tx.id)).map((tx) => tx.id);
    if (ids.length === 0) return;

    let success = 0;
    let skipped = 0;

    for (const id of ids) {
      const draft = getBookingDraftByTransactionId(id);
      if (!draft) { skipped += 1; continue; }
      const allowed = getAllowedActions(draft.workflowStatus, permissionCtx, draft.validationIssues);
      if (!allowed.includes(preferredAction)) { skipped += 1; continue; }
      try {
        await dispatchBookingAction(id, preferredAction, { role, actorName: role });
        success += 1;
      } catch {
        skipped += 1;
      }
    }

    setBatchMessage(`Sammelaktion '${preferredAction}': ${success} erfolgreich, ${skipped} übersprungen.`);
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    onRefresh();
  };

  const assignBatchAccount = async () => {
    if (!batchAccountSelection) {
      setBatchMessage('Bitte wählen Sie zuerst ein Konto für die Sammelzuweisung.');
      return;
    }

    const ids = filtered.filter((tx) => selectedSet.has(tx.id)).map((tx) => tx.id);
    if (ids.length === 0) return;

    const account = accountOptions.find((acc) => acc.number === batchAccountSelection.id);
    if (!account) { setBatchMessage('Gewähltes Konto wurde nicht gefunden.'); return; }

    let success = 0;
    let skipped = 0;
    for (const id of ids) {
      const draft = getBookingDraftByTransactionId(id);
      if (!draft || ['posted', 'reversed'].includes(draft.workflowStatus)) { skipped += 1; continue; }
      try {
        const nextLines = [...draft.lines];
        const bankAccountNumber = getConfiguredBankAccountNumber(
          draft,
          accounts ?? [],
          bankAccountNumberForTransaction(draft.transactionId),
          accounts === undefined,
        );
        if (!bankAccountNumber) { skipped += 1; continue; }
        const targetIndex = nextLines.findIndex((line) => line.accountId !== bankAccountNumber);
        const fallbackIndex = nextLines.findIndex((line) => line.accountId === '');
        const index = targetIndex >= 0 ? targetIndex : fallbackIndex >= 0 ? fallbackIndex : 0;
        if (index < 0) { skipped += 1; continue; }
        nextLines[index] = {
          ...nextLines[index],
          accountId: account.number,
          accountName: account.name,
          taxCaseKey: normalizeTaxCaseKey(nextLines[index].taxCaseKey ?? nextLines[index].taxCode ?? account.defaultTaxCode),
          taxCode:
            toLegacyTaxCode(normalizeTaxCaseKey(nextLines[index].taxCaseKey ?? nextLines[index].taxCode ?? account.defaultTaxCode))
            ?? nextLines[index].taxCode
            ?? account.defaultTaxCode
            ?? '',
        };
        await saveDraft({ ...draft, lines: nextLines }, role);
        success += 1;
      } catch {
        skipped += 1;
      }
    }

    setBatchMessage(`Sammel-Kontozuweisung (${account.number}): ${success} aktualisiert, ${skipped} übersprungen.`);
    onRefresh();
  };

  const saveInboxDraft = async (nextDraft: BookingDraft) => {
    if (['posted', 'reversed'].includes(nextDraft.workflowStatus)) {
      setBatchMessage('POSTED_DRAFT_IMMUTABLE: Storno oder Korrektur erforderlich.');
      return;
    }
    try {
      await saveDraft(nextDraft, role);
      onRefresh();
    } catch (error) {
      setBatchMessage(error instanceof Error ? error.message : 'Änderung konnte nicht gespeichert werden.');
    }
  };

  const updateInboxAccount = async (txId: string, accountNumber: string, accountName: string, defaultTaxCode?: string) => {
    const draft = getBookingDraftByTransactionId(txId);
    if (!draft) return;
    const nextLines = [...draft.lines];
    const bankAccountNumber = getConfiguredBankAccountNumber(
      draft,
      accounts ?? [],
      bankAccountNumberForTransaction(draft.transactionId),
      accounts === undefined,
    );
    if (!bankAccountNumber) {
      setBatchMessage('Bankkonto ist nicht konfiguriert.');
      return;
    }
    const targetIndex = nextLines.findIndex((line) => line.accountId !== bankAccountNumber);
    const fallbackIndex = nextLines.findIndex((line) => line.accountId === '');
    const index = targetIndex >= 0 ? targetIndex : fallbackIndex >= 0 ? fallbackIndex : 0;
    if (index < 0) return;
    nextLines[index] = {
      ...nextLines[index],
      accountId: accountNumber,
      accountName,
      taxCaseKey: normalizeTaxCaseKey(nextLines[index].taxCaseKey ?? nextLines[index].taxCode ?? defaultTaxCode),
      taxCode:
        toLegacyTaxCode(normalizeTaxCaseKey(nextLines[index].taxCaseKey ?? nextLines[index].taxCode ?? defaultTaxCode))
        ?? nextLines[index].taxCode
        ?? defaultTaxCode
        ?? '',
    };
    await saveInboxDraft({ ...draft, lines: nextLines });
  };

  const updateInboxTaxCase = async (txId: string, taxCaseValue: string) => {
    const draft = getBookingDraftByTransactionId(txId);
    if (!draft) return;
    const nextLines = [...draft.lines];
    const bankAccountNumber = getConfiguredBankAccountNumber(
      draft,
      accounts ?? [],
      bankAccountNumberForTransaction(draft.transactionId),
      accounts === undefined,
    );
    if (!bankAccountNumber) {
      setBatchMessage('Bankkonto ist nicht konfiguriert.');
      return;
    }
    const targetIndex = nextLines.findIndex((line) => line.accountId !== bankAccountNumber);
    const fallbackIndex = nextLines.findIndex((line) => line.accountId === '');
    const index = targetIndex >= 0 ? targetIndex : fallbackIndex >= 0 ? fallbackIndex : 0;
    if (index < 0) return;
    const taxCaseKey = normalizeTaxCaseKey(taxCaseValue);
    nextLines[index] = {
      ...nextLines[index],
      taxCaseKey,
      taxCode: toLegacyTaxCode(taxCaseKey) ?? (taxCaseKey ?? ''),
    };
    await saveInboxDraft({ ...draft, lines: nextLines });
  };

  const commitInboxBookingText = async (txId: string) => {
    const draft = getBookingDraftByTransactionId(txId);
    if (!draft) return;
    const edited = bookingTextEdits[txId];
    if (edited === undefined || edited === draft.bookingText) return;
    await saveInboxDraft({ ...draft, bookingText: edited });
  };

  // Derive primary action for previewTx
  const previewAllowedActions = useMemo(() => {
    if (!previewDraft) return [];
    return getAllowedActions(previewDraft.workflowStatus, permissionCtx, previewDraft.validationIssues);
  }, [previewDraft, permissionCtx]);
  const previewPrimaryAction = previewAllowedActions.find((a) => ['approve', 'post', 'submit_for_review'].includes(a));

  return (
    <div className="flex h-full">
      {/* ── LEFT: table area ── */}
      <div className="flex flex-col h-full flex-1 min-w-0">
        {/* Header — compact two-row layout */}
        <div className="px-6 pt-3 pb-0 border-b border-gray-100 shrink-0">
          {/* Row 1: icon + title */}
          <div className="flex items-center gap-3 pb-3">
            <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center text-accent shrink-0">
              <Inbox size={15} />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-black text-gray-900 leading-tight">Buchungs-Inbox</h1>
              <p className="text-xs text-gray-400 font-medium leading-tight">
                Workflow-Queues, Validierungen und Freigaben.
              </p>
            </div>
          </div>

          {/* Row 2: queue tabs + select tools */}
          <div className="flex items-center gap-3 pb-2">
            <InboxQueueTabs activeQueue={activeQueue} counts={queueCounts} onChange={setActiveQueue} />
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <button
                onClick={toggleSelectAllVisible}
                className="h-7 px-2.5 rounded-full border border-gray-200 bg-white text-[11px] font-bold text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 transition-colors"
              >
                <CheckSquare size={11} />
                {allVisibleSelected ? 'Auswahl aufheben' : 'Sichtbare markieren'}
              </button>
            </div>
          </div>

          {selectedIds.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-gray-700">
                <span className="font-bold">{selectedIds.length}</span> Vorgänge markiert für Sammelverarbeitung
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="min-w-64 max-w-72">
                  <AccountCombobox
                    accounts={accountOptions}
                    valueAccountId={batchAccountSelection?.id ?? ''}
                    valueAccountName={batchAccountSelection?.name ?? ''}
                    placeholder="Sammel-Konto wählen..."
                    onSelect={(account) => setBatchAccountSelection({ id: account.number, name: account.name })}
                  />
                </div>
                <button
                  onClick={assignBatchAccount}
                  className="h-9 px-3 rounded-full border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Konto zuweisen
                </button>
                <button
                  onClick={() => runBatchAction('request_receipt')}
                  className="h-9 px-3 rounded-full border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Beleg anfordern
                </button>
                <button
                  onClick={() => runBatchAction('submit_for_review')}
                  className="h-9 px-3 rounded-full border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Zur Prüfung
                </button>
                <button
                  onClick={() => runBatchAction('approve')}
                  className="h-9 px-3 rounded-full border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Freigeben
                </button>
                <button
                  onClick={() => runBatchAction('post')}
                  className="h-9 px-3 rounded-full bg-black text-white text-xs font-bold hover:bg-gray-900 transition-colors"
                >
                  Sammel-Buchen
                </button>
              </div>
            </div>
          )}

          {batchMessage && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-700" aria-live="polite">
              {batchMessage}
            </div>
          )}
        </div>

        {/* Toolbar row with count + Einklappen */}
        <div className="flex items-center justify-between px-6 py-2.5 border-b border-gray-100 bg-gray-50/40 shrink-0">
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">
            {filtered.length} Vorgänge
          </span>
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="h-8 px-3 rounded-full border border-gray-200 bg-white text-xs font-bold text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1.5 transition-colors"
          >
            {sidebarCollapsed ? <PanelRightOpen size={13} /> : <PanelRightClose size={13} />}
            {sidebarCollapsed ? 'Einblenden' : 'Einklappen'}
          </button>
        </div>

        {/* Compact table */}
        <div className="flex-1 overflow-auto p-6">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-gray-400 font-bold border-b border-gray-100">
                <th scope="col" className="px-3 py-3 w-10">
                  <input
                    type="checkbox"
                    aria-label="Alle sichtbaren Vorgänge markieren"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="rounded border-gray-300"
                  />
                </th>
                <th scope="col" className="px-3 py-3 w-32">STATUS</th>
                <th scope="col" className="px-3 py-3 w-24">DATUM</th>
                <th scope="col" className="px-3 py-3">EMPFÄNGER / ZWECK</th>
                <th scope="col" className="px-3 py-3 text-right w-44">ISSUES</th>
                <th scope="col" className="px-3 py-3 text-right w-32">BETRAG</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12">
                    <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center">
                      <div className="text-sm font-bold text-gray-700">Keine Vorgänge in dieser Queue</div>
                      <div className="mt-1 text-sm text-gray-500">Passe Filter oder Queue an, um Vorgänge anzuzeigen.</div>
                    </div>
                  </td>
                </tr>
              ) : null}
              {filtered.map((tx) => {
                const draft = getBookingDraftByTransactionId(tx.id);
                const status = getStatusPresentation(tx.workflowStatus);
                const isSelectedPreview = previewTx?.id === tx.id;
                const blockerCount = draft?.validationIssues.filter((issue) => issue.blocking).length ?? 0;

                return (
                  <tr
                    key={tx.id}
                    className={`hover:bg-gray-50/60 transition-colors ${
                      isSelectedPreview ? 'bg-gray-50/90 border-l-2 border-dark-1' : ''
                    } ${blockerCount > 0 ? 'border-l-2 border-error-border' : ''}`}
                  >
                    <td className="px-3 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`${tx.payee} markieren`}
                        checked={selectedSet.has(tx.id)}
                        onChange={() => toggleRowSelection(tx.id)}
                        className="rounded border-gray-300"
                      />
                    </td>
                    <td className="px-3 py-4 whitespace-nowrap align-top">
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${status.className}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-3 py-4 whitespace-nowrap text-sm text-gray-500 font-medium align-top">
                      {new Date(tx.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}
                    </td>
                    <td className="px-3 py-4 align-top">
                      <button
                        type="button"
                        onClick={() => setPreviewId((current) => (current === tx.id ? null : tx.id))}
                        aria-label={`${tx.payee} öffnen`}
                        aria-pressed={isSelectedPreview}
                        className="w-full text-left rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
                      >
                        <div className="font-bold text-gray-900 text-sm">{tx.payee}</div>
                        <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">{tx.description}</div>
                      </button>
                    </td>
                    <td className="px-3 py-4 text-right align-top">
                      <div className="flex flex-col items-end gap-1">
                        <IssueBadges transaction={tx} />
                      </div>
                    </td>
                    <td className={`px-3 py-4 whitespace-nowrap text-sm font-bold text-right align-top ${tx.amount < 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                      {formatCurrency(tx.amount, tx.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── RIGHT: editing sidebar ── */}
      <aside
        className={`shrink-0 flex flex-col h-full border-l border-gray-100 transition-all duration-300 overflow-hidden ${
          !sidebarCollapsed ? 'w-80 xl:w-80 opacity-100' : 'w-0 opacity-0 pointer-events-none'
        }`}
        aria-hidden={sidebarCollapsed}
      >
        {!previewTx || !previewDraft ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm p-6 text-center gap-3">
            <Inbox size={28} className="text-gray-300" />
            <span>Transaktion auswählen um die Schnellbuchung zu starten</span>
          </div>
        ) : (
          <>
            {/* Header card */}
            <div className="p-4 border-b border-gray-100 shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-bold text-gray-900 leading-tight truncate">{previewTx.payee}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {new Date(previewTx.date).toLocaleDateString('de-DE')}
                    {previewDraft.externalReference ? ` · ${previewDraft.externalReference}` : ''}
                  </div>
                </div>
                <div className={`text-base font-bold shrink-0 ${previewTx.amount < 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                  {formatCurrency(previewTx.amount, previewTx.currency)}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${getStatusPresentation(previewTx.workflowStatus).className}`}>
                  {getStatusPresentation(previewTx.workflowStatus).label}
                </span>
                {!previewTx.hasReceipt && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-100 text-gray-600">
                    Ohne Beleg
                  </span>
                )}
              </div>
            </div>

            {/* Scrollable editing form */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
              {/* TRANSAKTIONSDETAILS */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">
                  Transaktionsdetails
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500 shrink-0">Verwendungszweck</span>
                    <span className="font-medium text-gray-800 text-right line-clamp-2">
                      {previewTx.description ?? '—'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500 shrink-0">Buchungstext</span>
                    <span className="font-medium text-gray-800 text-right">
                      {previewDraft.bookingText || '—'}
                    </span>
                  </div>
                  {previewTx.suggestion && (
                    <div className="flex justify-between gap-3">
                      <span className="text-gray-500 shrink-0">Kategorie</span>
                      <span className="font-medium text-gray-800 text-right">{previewTx.suggestion}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* SCHNELLBUCHUNG */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">
                  Schnellbuchung
                </div>
                <div className="space-y-3">
                  {!previewBankAccountNumber && (
                    <p className="text-xs text-red-700" role="alert">
                      Bankkonto ist nicht konfiguriert. Schnellbuchung ist deaktiviert.
                    </p>
                  )}
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">Konto</label>
                    <AccountCombobox
                      accounts={accountOptions}
                      valueAccountId={previewCounterLine?.accountId ?? ''}
                      valueAccountName={previewCounterLine?.accountName ?? ''}
                      disabled={!previewAccountEditable || !previewBankAccountNumber}
                      onSelect={(account) =>
                        updateInboxAccount(previewTx.id, account.number, account.name, account.defaultTaxCode)
                      }
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">Steuerfall</label>
                    <select
                      value={normalizeTaxCaseKey(previewCounterLine?.taxCaseKey ?? previewCounterLine?.taxCode) ?? ''}
                      disabled={!previewAccountEditable || !previewBankAccountNumber}
                      onChange={(e) => updateInboxTaxCase(previewTx.id, e.target.value)}
                      className="h-10 w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white disabled:bg-gray-50"
                    >
                      <option value="">Keine</option>
                      {TAX_CASE_OPTIONS.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">Notiz</label>
                    <textarea
                      value={notesEdits[previewTx.id] ?? ''}
                      onChange={(e) =>
                        setNotesEdits((prev) => ({ ...prev, [previewTx.id]: e.target.value }))
                      }
                      placeholder="Optionale Notiz..."
                      rows={3}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">Buchungstext bearbeiten</label>
                    <input
                      type="text"
                      value={bookingTextEdits[previewTx.id] ?? previewDraft.bookingText ?? ''}
                      disabled={!previewAccountEditable}
                      onChange={(e) =>
                        setBookingTextEdits((prev) => ({ ...prev, [previewTx.id]: e.target.value }))
                      }
                      onBlur={() => commitInboxBookingText(previewTx.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      placeholder="Buchungstext eingeben"
                      className="h-10 w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white disabled:bg-gray-50"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Action bar */}
            <div className="p-4 border-t border-gray-100 flex gap-2 shrink-0">
              <button
                onClick={() => handleInlineAction(previewTx)}
                className="flex-1 py-3 rounded-xl bg-black text-white font-bold text-sm hover:bg-gray-900 transition-colors"
              >
                {nextActionLabel(previewPrimaryAction)}
              </button>
              <button
                onClick={() => onOpenTransaction(previewTx.id)}
                className="px-5 py-3 rounded-xl border border-gray-200 font-bold text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Erweitern
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
