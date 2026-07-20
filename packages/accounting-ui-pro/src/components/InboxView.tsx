import { useEffect, useMemo, useState } from 'react';
import { getQueueCounts, InboxQueueKey, txMatchesQueue } from '../domain/selectors';
import { normalizeTaxCaseKey, toLegacyTaxCode } from '../domain/taxCases';
import { getAllowedActions } from '../domain/workflow';
import { mockAccounts } from '../mocks/accounts';
import { permissionContextForRole } from '../mocks/users';
import {
  dispatchBookingAction,
  getBookingDraftByTransactionId,
  saveDraft,
  setTransactionReceiptStatus,
} from '../services/mockBookingStore';
import { Account, BookingAction, Transaction, UserRole } from '../types';
import InboxDetailPanel from './inbox/InboxDetailPanel';
import InboxHeader from './inbox/InboxHeader';
import InboxTransactionTable from './inbox/InboxTransactionTable';

interface InboxViewProps {
  role: UserRole;
  transactions: Transaction[];
  onOpenTransaction: (transactionId: string) => void;
  onRefresh: () => void;
  forcedPreviewTransactionId?: string | null;
}

export default function InboxView({
  role,
  transactions,
  onOpenTransaction,
  onRefresh,
  forcedPreviewTransactionId,
}: InboxViewProps) {
  const [activeQueue, setActiveQueue] = useState<InboxQueueKey>('all');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchMessage, setBatchMessage] = useState<string>('');
  const [batchAccountSelection, setBatchAccountSelection] = useState<{ id: string; name: string } | null>(null);
  const [bookingTextEdits, setBookingTextEdits] = useState<Record<string, string>>({});
  const [notesEdits, setNotesEdits] = useState<Record<string, string>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const permissionCtx = permissionContextForRole(role);
  const queueCounts = useMemo(() => getQueueCounts(transactions), [transactions]);
  const filtered = useMemo(
    () => transactions.filter((tx) => txMatchesQueue(tx, activeQueue)),
    [transactions, activeQueue],
  );

  const previewTx = previewId ? filtered.find((tx) => tx.id === previewId) ?? null : null;
  const previewDraft = previewTx ? getBookingDraftByTransactionId(previewTx.id) : undefined;
  const previewCounterLine = previewDraft?.lines.find((line) => line.accountId !== '1200') ?? previewDraft?.lines[0];
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

  const selectSimilarToPreview = () => {
    if (!previewTx) return;
    const similar = filtered.filter(
      (tx) =>
        tx.id !== previewTx.id &&
        tx.amount * previewTx.amount > 0 &&
        (tx.payee === previewTx.payee || tx.suggestion === previewTx.suggestion),
    );
    setSelectedIds([previewTx.id, ...similar.map((tx) => tx.id)]);
  };

  const handleInlineAction = (tx: Transaction) => {
    const draft = getBookingDraftByTransactionId(tx.id);
    if (!draft) return;
    const allowed = getAllowedActions(draft.workflowStatus, permissionCtx, draft.validationIssues);
    const primary = allowed.find((a) => ['approve', 'post', 'submit_for_review'].includes(a));
    if (!primary) {
      onOpenTransaction(tx.id);
      return;
    }
    try {
      dispatchBookingAction(tx.id, primary, { role, actorName: role });
      onRefresh();
    } catch {
      onOpenTransaction(tx.id);
    }
  };

  const runBatchAction = (preferredAction: BookingAction) => {
    const ids = filtered.filter((tx) => selectedSet.has(tx.id)).map((tx) => tx.id);
    if (ids.length === 0) return;

    let success = 0;
    let skipped = 0;

    ids.forEach((id) => {
      const draft = getBookingDraftByTransactionId(id);
      if (!draft) { skipped += 1; return; }
      const allowed = getAllowedActions(draft.workflowStatus, permissionCtx, draft.validationIssues);
      if (!allowed.includes(preferredAction)) { skipped += 1; return; }
      try {
        dispatchBookingAction(id, preferredAction, { role, actorName: role });
        success += 1;
      } catch {
        skipped += 1;
      }
    });

    setBatchMessage(`Sammelaktion '${preferredAction}': ${success} erfolgreich, ${skipped} übersprungen.`);
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    onRefresh();
  };

  const assignBatchAccount = () => {
    if (!batchAccountSelection) {
      setBatchMessage('Bitte wählen Sie zuerst ein Konto für die Sammelzuweisung.');
      return;
    }

    const ids = filtered.filter((tx) => selectedSet.has(tx.id)).map((tx) => tx.id);
    if (ids.length === 0) return;

    const account = mockAccounts.find((acc) => acc.number === batchAccountSelection.id);
    if (!account) { setBatchMessage('Gewähltes Konto wurde nicht gefunden.'); return; }

    let success = 0;
    let skipped = 0;
    ids.forEach((id) => {
      const draft = getBookingDraftByTransactionId(id);
      if (!draft || ['posted', 'reversed'].includes(draft.workflowStatus)) { skipped += 1; return; }
      try {
        const nextLines = [...draft.lines];
        const targetIndex = nextLines.findIndex((line) => line.accountId !== '1200');
        const fallbackIndex = nextLines.findIndex((line) => line.accountId === '');
        const index = targetIndex >= 0 ? targetIndex : fallbackIndex >= 0 ? fallbackIndex : 0;
        if (index < 0) { skipped += 1; return; }
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
        saveDraft({ ...draft, lines: nextLines }, role);
        success += 1;
      } catch {
        skipped += 1;
      }
    });

    setBatchMessage(`Sammel-Kontozuweisung (${account.number}): ${success} aktualisiert, ${skipped} übersprungen.`);
    onRefresh();
  };

  const updateInboxAccount = (txId: string, accountNumber: string, accountName: string, defaultTaxCode?: string) => {
    const draft = getBookingDraftByTransactionId(txId);
    if (!draft) return;
    const nextLines = [...draft.lines];
    const targetIndex = nextLines.findIndex((line) => line.accountId !== '1200');
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
    saveDraft({ ...draft, lines: nextLines }, role);
    onRefresh();
  };

  const updateInboxTaxCase = (txId: string, taxCaseValue: string) => {
    const draft = getBookingDraftByTransactionId(txId);
    if (!draft) return;
    const nextLines = [...draft.lines];
    const targetIndex = nextLines.findIndex((line) => line.accountId !== '1200');
    const fallbackIndex = nextLines.findIndex((line) => line.accountId === '');
    const index = targetIndex >= 0 ? targetIndex : fallbackIndex >= 0 ? fallbackIndex : 0;
    if (index < 0) return;
    const taxCaseKey = normalizeTaxCaseKey(taxCaseValue);
    nextLines[index] = {
      ...nextLines[index],
      taxCaseKey,
      taxCode: toLegacyTaxCode(taxCaseKey) ?? (taxCaseKey ?? ''),
    };
    saveDraft({ ...draft, lines: nextLines }, role);
    onRefresh();
  };

  const commitInboxBookingText = (txId: string) => {
    const draft = getBookingDraftByTransactionId(txId);
    if (!draft) return;
    const edited = bookingTextEdits[txId];
    if (edited === undefined || edited === draft.bookingText) return;
    saveDraft({ ...draft, bookingText: edited }, role);
    onRefresh();
  };

  const updateReceiptInline = (txId: string, hasReceipt: boolean) => {
    setTransactionReceiptStatus(txId, hasReceipt, role);
    onRefresh();
  };

  // Derive primary action for previewTx
  const previewAllowedActions = useMemo(() => {
    if (!previewDraft) return [];
    return getAllowedActions(previewDraft.workflowStatus, permissionCtx, previewDraft.validationIssues);
  }, [previewDraft, permissionCtx]);
  const previewPrimaryAction = previewAllowedActions.find((a) => ['approve', 'post', 'submit_for_review'].includes(a));

  const handleClickRow = (txId: string) => {
    setPreviewId((current) => (current === txId ? null : txId));
  };

  const handleBatchAccountSelect = (account: Account) => {
    setBatchAccountSelection({ id: account.number, name: account.name });
  };

  return (
    <div className="flex h-full">
      {/* ── LEFT: table area ── */}
      <div className="flex flex-col h-full flex-1 min-w-0">
        <InboxHeader
          activeQueue={activeQueue}
          queueCounts={queueCounts}
          onQueueChange={setActiveQueue}
          selectedIds={selectedIds}
          allVisibleSelected={allVisibleSelected}
          onToggleSelectAll={toggleSelectAllVisible}
          previewTxExists={!!previewTx}
          onSelectSimilar={selectSimilarToPreview}
          batchAccountSelection={batchAccountSelection}
          onBatchAccountSelect={handleBatchAccountSelect}
          onAssignBatchAccount={assignBatchAccount}
          onBatchAction={runBatchAction}
          batchMessage={batchMessage}
          filteredCount={filtered.length}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        />
        <InboxTransactionTable
          filtered={filtered}
          selectedSet={selectedSet}
          previewId={previewId}
          allVisibleSelected={allVisibleSelected}
          onToggleSelectAll={toggleSelectAllVisible}
          onToggleRowSelect={toggleRowSelection}
          onClickRow={handleClickRow}
        />
      </div>

      {/* ── RIGHT: editing sidebar ── */}
      <InboxDetailPanel
        sidebarCollapsed={sidebarCollapsed}
        previewTx={previewTx}
        previewDraft={previewDraft}
        previewCounterLine={previewCounterLine}
        previewAccountEditable={previewAccountEditable}
        previewPrimaryAction={previewPrimaryAction}
        notesEdits={notesEdits}
        bookingTextEdits={bookingTextEdits}
        onNotesChange={(txId, value) => setNotesEdits((prev) => ({ ...prev, [txId]: value }))}
        onBookingTextChange={(txId, value) => setBookingTextEdits((prev) => ({ ...prev, [txId]: value }))}
        onBookingTextCommit={commitInboxBookingText}
        onUpdateAccount={updateInboxAccount}
        onUpdateTaxCase={updateInboxTaxCase}
        onUpdateReceipt={updateReceiptInline}
        onPrimaryAction={handleInlineAction}
        onOpenTransaction={onOpenTransaction}
      />
    </div>
  );
}
