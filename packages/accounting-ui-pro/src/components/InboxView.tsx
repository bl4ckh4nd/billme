import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  CheckSquare,
  Inbox,
  PanelRightClose,
  PanelRightOpen,
  TriangleAlert,
} from 'lucide-react';
import {
  Badge, Button, Card, Checkbox, EmptyState, formatEmptyValue, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea,
} from '@billme/ui';
import { isProfitAndLossAccount } from '@billme/accounting-shared';
import { userFacingReference } from '../domain/references';
import { bookingActionLabels, getQueueCounts, InboxQueueKey, txMatchesQueue } from '../domain/selectors';
import { normalizeTaxCaseKey, TAX_CASE_OPTIONS, toLegacyTaxCode } from '../domain/taxCases';
import { getAllowedActions } from '../domain/workflow';
import { permissionContextForRole } from '../domain/permissions';
import { useAccountingWorkspace, useWorkspaceLifetime } from '../AccountingWorkspaceContext';
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';
import AccountCombobox from './AccountCombobox';
import { getConfiguredBankAccountNumber } from './ReconciliationWorkbench';
import { Account, BookingAction, BookingDraft, LinkedInvoiceSummary, OpenRouterVlmConfig, Transaction, TransactionDocumentAnalysis, UserRole } from '../types';
import InboxQueueTabs from './InboxQueueTabs';
import IssueBadges, { StatusBadge } from './IssueBadges';

interface InboxViewProps {
  role: UserRole;
  dataAdapter?: ProAccountingDataAdapter;
  accounts?: Account[];
  bankAccountNumber?: string;
  bankAccountNumberByTransactionId?: Record<string, string>;
  transactions: Transaction[];
  onOpenTransaction: (transactionId: string) => void;
  onRefresh: () => void;
  forcedPreviewTransactionId?: string | null;
  /** Queue shared with the workbench; uncontrolled when omitted. */
  activeQueue?: InboxQueueKey;
  onQueueChange?: (queue: InboxQueueKey) => void;
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);
}

function nextActionLabel(action: BookingAction | undefined) {
  return action ? bookingActionLabels[action] : bookingActionLabels.post;
}

export default function InboxView({
  role,
  dataAdapter,
  accounts,
  bankAccountNumber: configuredBankAccountNumber,
  bankAccountNumberByTransactionId,
  transactions,
  onOpenTransaction,
  onRefresh,
  forcedPreviewTransactionId,
  activeQueue: controlledQueue,
  onQueueChange,
}: InboxViewProps) {
  const store = useAccountingWorkspace();
  const captureLifetime = useWorkspaceLifetime();
  const { dispatchBookingAction, getBookingDraftByTransactionId, saveDraft } = store;
  const accountOptions = accounts ?? store.listAccounts();
  const [localQueue, setLocalQueue] = useState<InboxQueueKey>('all');
  const activeQueue = controlledQueue ?? localQueue;
  const setActiveQueue = onQueueChange ?? setLocalQueue;
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchMessage, setBatchMessage] = useState<string>('');
  const [batchAccountSelection, setBatchAccountSelection] = useState<{ id: string; name: string } | null>(null);
  const [bookingTextEdits, setBookingTextEdits] = useState<Record<string, string>>({});
  const [notesEdits, setNotesEdits] = useState<Record<string, string>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [linkedInvoice, setLinkedInvoice] = useState<LinkedInvoiceSummary | null>(null);
  const [vlmConfig, setVlmConfig] = useState<OpenRouterVlmConfig | null>(null);
  const [vlmModel, setVlmModel] = useState('');
  const [vlmDocument, setVlmDocument] = useState<{ mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'; data: string; fileName?: string } | null>(null);
  const [vlmAnalysis, setVlmAnalysis] = useState<TransactionDocumentAnalysis | null>(null);
  const [vlmBusy, setVlmBusy] = useState(false);
  const [vlmError, setVlmError] = useState<string | null>(null);

  const permissionCtx = permissionContextForRole(role);
  const canMutate = permissionCtx.canMutate;
  const bankAccountNumberForTransaction = (transactionId: string) =>
    bankAccountNumberByTransactionId?.[transactionId] ?? configuredBankAccountNumber;
  const queueCounts = useMemo(() => getQueueCounts(transactions), [transactions]);
  const filtered = useMemo(
    () => transactions.filter((tx) => txMatchesQueue(tx, activeQueue)),
    [transactions, activeQueue],
  );

  const previewTx = previewId ? filtered.find((tx) => tx.id === previewId) ?? null : null;
  const previewDraft = previewTx ? getBookingDraftByTransactionId(previewTx.id) : undefined;
  const previewReference = userFacingReference(previewDraft?.externalReference);
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

  useEffect(() => {
    setLinkedInvoice(null);
    setVlmAnalysis(null);
    setVlmDocument(null);
    setVlmError(null);
    let cancelled = false;
    const selectedTransaction = previewTx;
    if (!selectedTransaction || !dataAdapter?.getLinkedInvoice) return () => { cancelled = true; };
    void Promise.resolve(dataAdapter.getLinkedInvoice(selectedTransaction.id)).then((invoice) => {
      if (!cancelled) setLinkedInvoice(invoice);
    }).catch((error: unknown) => {
      if (!cancelled) setVlmError(error instanceof Error ? error.message : 'Verknüpfte Rechnung konnte nicht geladen werden.');
    });
    return () => { cancelled = true; };
  }, [dataAdapter, previewTx?.id]);

  useEffect(() => {
    if (!dataAdapter?.getOpenRouterVlmConfig) return;
    let cancelled = false;
    void dataAdapter.getOpenRouterVlmConfig().then((config) => {
      if (!cancelled) {
        setVlmConfig(config);
        setVlmModel(config.model);
      }
    }).catch(() => { if (!cancelled) setVlmConfig(null); });
    return () => { cancelled = true; };
  }, [dataAdapter]);

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
      const result = await dispatchBookingAction(tx.id, primary, { role, actorName: role });
      const blocking = (result?.validationIssues ?? []).filter((issue) => issue.blocking);
      setBatchMessage(blocking.length
        ? `${bookingActionLabels[primary]} nicht möglich: ${blocking.map((issue) => issue.message).join(' ')}`
        : '');
      onRefresh();
    } catch (error) {
      setBatchMessage(error instanceof Error ? error.message : 'Aktion konnte nicht gespeichert werden.');
    }
  };

  const runBatchAction = async (preferredAction: BookingAction) => {
    const isCurrent = captureLifetime();
    const ids = filtered.filter((tx) => selectedSet.has(tx.id)).map((tx) => tx.id);
    if (ids.length === 0) return;

    let success = 0;
    let skipped = 0;
    const withoutTaxCase: string[] = [];

    for (const id of ids) {
      if (!isCurrent()) return;
      const draft = getBookingDraftByTransactionId(id);
      if (!draft) { skipped += 1; continue; }
      const allowed = getAllowedActions(draft.workflowStatus, permissionCtx, draft.validationIssues);
      if (!allowed.includes(preferredAction)) { skipped += 1; continue; }
      // A batch never books gross: an Erlös-/Aufwandskonto without Steuerfall is left for a person to decide.
      if (preferredAction === 'post' && draft.lines.some((line) => isProfitAndLossAccount(draft.chartFramework ?? 'SKR03', line.accountId) && !line.taxCaseKey && !line.taxCode)) { withoutTaxCase.push(id); continue; }
      try {
        await dispatchBookingAction(id, preferredAction, { role, actorName: role });
        success += 1;
      } catch {
        skipped += 1;
      }
    }

    if (!isCurrent()) return;
    const taxHint = withoutTaxCase.length ? ` ${withoutTaxCase.length} ohne Steuerfall ausgelassen: Steuerfall im Entwurf wählen, dann buchen.` : '';
    setBatchMessage(`Sammelaktion ${bookingActionLabels[preferredAction]}: ${success} erfolgreich, ${skipped} übersprungen.${taxHint}`);
    // The skipped ones stay selected, so they can be opened and completed.
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id) || withoutTaxCase.includes(id)));
    onRefresh();
  };

  const assignBatchAccount = async () => {
    const isCurrent = captureLifetime();
    if (!canMutate) return;
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
      if (!isCurrent()) return;
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
    if (!canMutate) {
      setBatchMessage('Diese Rolle darf Buchungen nur lesen.');
      return;
    }
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

  const readVlmDocument = async (file: File) => {
    const mimeType = file.type as 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
    if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      setVlmError('Bitte wählen Sie eine PDF-, JPEG-, PNG- oder WebP-Datei.');
      return;
    }
    if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
      setVlmError('Das Dokument darf höchstens 10 MiB groß sein.');
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    setVlmDocument({ mimeType, data: btoa(binary), fileName: file.name });
    setVlmAnalysis(null);
    setVlmError(null);
  };

  const analyzePreviewDocument = async () => {
    if (!previewTx || !vlmDocument || !dataAdapter?.analyzeTransactionDocument) return;
    setVlmBusy(true);
    setVlmError(null);
    try {
      const result = await dataAdapter.analyzeTransactionDocument({
        model: vlmModel || undefined,
        transaction: {
          id: previewTx.id,
          date: previewTx.date,
          amount: previewTx.amount,
          currency: previewTx.currency,
          type: previewTx.amount >= 0 ? 'income' : 'expense',
          counterparty: previewTx.payee,
          purpose: previewTx.description,
          linkedInvoiceId: linkedInvoice?.id,
          suggestedAccountNumber: previewDraft?.lines.find((line) => line.accountId)?.accountId,
        },
        document: vlmDocument,
      });
      setVlmAnalysis(result);
    } catch (error) {
      setVlmError(error instanceof Error ? error.message : 'Dokument konnte nicht analysiert werden.');
    } finally {
      setVlmBusy(false);
    }
  };

  const applyVlmToDraft = async () => {
    if (!previewTx || !previewDraft || !vlmAnalysis || !previewAccountEditable || !canMutate) return;
    const extraction = vlmAnalysis.extraction;
    const nextLines = [...previewDraft.lines];
    const bankAccountNumber = getConfiguredBankAccountNumber(
      previewDraft,
      accounts ?? [],
      bankAccountNumberForTransaction(previewDraft.transactionId),
      accounts === undefined,
    );
    const targetIndex = bankAccountNumber
      ? nextLines.findIndex((line) => line.accountId !== bankAccountNumber)
      : -1;
    const lineIndex = targetIndex >= 0
      ? targetIndex
      : bankAccountNumber
        ? nextLines.findIndex((line) => line.accountId === '')
        : -1;
    const account = extraction.suggestedAccountNumber
      ? accountOptions.find((candidate) => candidate.number === extraction.suggestedAccountNumber)
      : undefined;
    const taxCase = extraction.suggestedTaxCase && TAX_CASE_OPTIONS.some((option) => option.key === extraction.suggestedTaxCase)
      ? normalizeTaxCaseKey(extraction.suggestedTaxCase)
      : undefined;
    if (lineIndex >= 0) {
      const current = nextLines[lineIndex];
      nextLines[lineIndex] = {
        ...current,
        ...(account ? { accountId: account.number, accountName: account.name } : {}),
        ...(taxCase ? { taxCaseKey: taxCase, taxCode: toLegacyTaxCode(taxCase) ?? current.taxCode } : {}),
        evidenceType: 'openrouter_vlm',
        evidenceReference: `model=${vlmAnalysis.metadata.model};documentSha256=${vlmAnalysis.metadata.documentSha256}`,
      };
    }
    const bookingText = previewDraft.bookingText.trim() ? undefined : extraction.paymentReference ?? extraction.invoiceNumber;
    const externalReference = previewDraft.externalReference?.trim() ? undefined : extraction.invoiceNumber;
    await saveInboxDraft({
      ...previewDraft,
      ...(bookingText ? { bookingText } : {}),
      ...(externalReference ? { externalReference } : {}),
      lines: nextLines,
    });
    setBatchMessage('VLM-Vorschlag in den Entwurf übernommen; Validierung bleibt maßgeblich.');
  };

  // Derive primary action for previewTx
  const previewAllowedActions = useMemo(() => {
    if (!previewDraft) return [];
    const actions = getAllowedActions(previewDraft.workflowStatus, permissionCtx, previewDraft.validationIssues);
    return previewTx?.isVirtualPosted
      ? actions.filter((action) => !['save_draft', 'reverse', 'create_correction'].includes(action))
      : actions.filter((action) => action !== 'save_draft');
  }, [previewDraft, previewTx, permissionCtx]);
  const previewPrimaryAction = previewAllowedActions.find((a) => ['approve', 'post', 'submit_for_review'].includes(a));

  const eyebrow = 'mb-2 text-eyebrow uppercase text-muted';
  const amountTone = (amount: number) => (amount > 0 ? 'text-success-text' : 'text-foreground');

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Left: transaction table */}
      <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
        {/* Title lives in the page header; kept for assistive tech. */}
        <div className="sr-only">
          <h2>Buchungs-Inbox</h2>
          <p>Workflow-Queues, Validierungen und Freigaben.</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <InboxQueueTabs activeQueue={activeQueue} counts={queueCounts} onChange={setActiveQueue} />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="text-caption text-muted tabular-nums">{filtered.length} Vorgänge</span>
            <Button variant="secondary" size="sm" onClick={toggleSelectAllVisible}>
              <CheckSquare size={14} aria-hidden="true" />
              {allVisibleSelected ? 'Auswahl aufheben' : 'Sichtbare markieren'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSidebarCollapsed((v) => !v)}>
              {sidebarCollapsed ? <PanelRightOpen size={14} aria-hidden="true" /> : <PanelRightClose size={14} aria-hidden="true" />}
              {sidebarCollapsed ? 'Einblenden' : 'Einklappen'}
            </Button>
          </div>
        </div>

        {selectedIds.length > 0 && (
          <Card padding="sm" className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            <div className="text-control text-foreground">
              <span className="font-semibold tabular-nums">{selectedIds.length}</span> Vorgänge markiert für Sammelverarbeitung
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-64">
                <AccountCombobox
                  accounts={accountOptions}
                  valueAccountId={batchAccountSelection?.id ?? ''}
                  valueAccountName={batchAccountSelection?.name ?? ''}
                  placeholder="Sammel-Konto wählen..."
                  onSelect={(account) => setBatchAccountSelection({ id: account.number, name: account.name })}
                />
              </div>
              <Button variant="secondary" onClick={assignBatchAccount} disabled={!canMutate}>
                Konto zuweisen
              </Button>
              <Button variant="secondary" onClick={() => runBatchAction('request_receipt')} disabled={!canMutate}>
                Beleg anfordern
              </Button>
              <Button variant="secondary" onClick={() => runBatchAction('submit_for_review')} disabled={!canMutate}>
                {bookingActionLabels.submit_for_review}
              </Button>
              <Button variant="secondary" onClick={() => runBatchAction('approve')} disabled={!canMutate}>
                Freigeben
              </Button>
              <Button variant="dark" onClick={() => runBatchAction('post')} disabled={!canMutate}>
                Sammel-Buchen
              </Button>
            </div>
          </Card>
        )}

        {batchMessage && (
          <div className="shrink-0 rounded-control border border-border bg-surface px-3 py-2.5 text-control text-foreground" role="status" aria-live="polite">
            {batchMessage}
          </div>
        )}

        <Table aria-label="Vorgänge" containerClassName="min-h-0">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Alle sichtbaren Vorgänge markieren"
                  checked={allVisibleSelected}
                  indeterminate={!allVisibleSelected && filtered.some((tx) => selectedSet.has(tx.id))}
                  onChange={toggleSelectAllVisible}
                />
              </TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className="w-20">Datum</TableHead>
              <TableHead>Empfänger / Zweck</TableHead>
              <TableHead numeric className="w-44">Hinweise</TableHead>
              <TableHead numeric className="w-32">Betrag</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    title="Keine Vorgänge in dieser Queue"
                    description="Passe Filter oder Queue an, um Vorgänge anzuzeigen."
                  />
                </TableCell>
              </TableRow>
            ) : null}
            {filtered.map((tx) => {
              const draft = getBookingDraftByTransactionId(tx.id);
              const isSelectedPreview = previewTx?.id === tx.id;
              const blockerCount = draft?.validationIssues.filter((issue) => issue.blocking).length ?? 0;

              return (
                <TableRow
                  key={tx.id}
                  selected={isSelectedPreview}
                  className={`hover:bg-surface-muted ${
                    blockerCount > 0 && !isSelectedPreview ? '[&>td:first-child]:shadow-[inset_2px_0_0_var(--color-error)]' : ''
                  }`}
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`${tx.payee} markieren`}
                      checked={selectedSet.has(tx.id)}
                      onChange={() => toggleRowSelection(tx.id)}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <StatusBadge status={tx.workflowStatus} />
                  </TableCell>
                  <TableCell muted className="whitespace-nowrap font-mono tabular-nums">
                    {new Date(tx.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}
                  </TableCell>
                  <TableCell className="w-full max-w-0">
                    <button
                      type="button"
                      onClick={() => setPreviewId((current) => (current === tx.id ? null : tx.id))}
                      aria-label={`${tx.payee} öffnen`}
                      aria-pressed={isSelectedPreview}
                      className="flex w-full items-baseline gap-2 rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <span className="shrink-0 font-medium text-foreground">{tx.payee}</span>
                      <span className="min-w-0 truncate text-caption text-muted">{tx.description}</span>
                    </button>
                  </TableCell>
                  <TableCell className="text-right">
                    <IssueBadges transaction={tx} />
                  </TableCell>
                  <TableCell numeric className={`whitespace-nowrap font-medium ${amountTone(tx.amount)}`}>
                    {formatCurrency(tx.amount, tx.currency)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Right: editing sidebar */}
      <aside
        className={`h-full w-78 shrink-0 flex-col overflow-hidden rounded-card border border-border bg-surface ${sidebarCollapsed ? 'hidden' : 'flex'}`}
        aria-hidden={sidebarCollapsed}
      >
        {!previewTx || !previewDraft ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 py-10 text-center text-control text-muted">
            <Inbox size={20} aria-hidden="true" />
            <span>Transaktion auswählen um die Schnellbuchung zu starten</span>
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-border px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-section text-foreground">{previewTx.payee}</div>
                  <div className="text-caption text-muted">
                    {new Date(previewTx.date).toLocaleDateString('de-DE')}
                    {previewReference ? ` · ${previewReference}` : ''}
                  </div>
                </div>
                <div className={`shrink-0 font-mono text-heading font-bold tabular-nums ${amountTone(previewTx.amount)}`}>
                  {formatCurrency(previewTx.amount, previewTx.currency)}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <StatusBadge status={previewTx.workflowStatus} />
                {!previewTx.hasReceipt && <Badge tone="warning">Ohne Beleg</Badge>}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3">
              <div>
                <h3 className={eyebrow}>Transaktionsdetails</h3>
                <div className="flex flex-col gap-1.5 text-control">
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-muted">Verwendungszweck</span>
                    <span className="line-clamp-2 text-right font-medium text-foreground">
                      {formatEmptyValue(previewTx.description)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-muted">Buchungstext</span>
                    <span className="text-right font-medium text-foreground">
                      {formatEmptyValue(previewDraft.bookingText)}
                    </span>
                  </div>
                  {previewTx.suggestion && (
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted">Kategorie</span>
                      <span className="text-right font-medium text-foreground">{previewTx.suggestion}</span>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <h3 className={eyebrow}>Verknüpfte Rechnung</h3>
                {linkedInvoice ? (
                  <div className="rounded-control border border-border bg-surface-muted px-2.5 py-2 text-control">
                    <div className="flex items-center justify-between gap-2 font-semibold text-foreground">
                      <span>{linkedInvoice.number}</span>
                      <span className="font-mono tabular-nums">{formatCurrency(linkedInvoice.amount, previewTx.currency)}</span>
                    </div>
                    <div className="mt-0.5 text-caption text-muted">{linkedInvoice.client} · {new Date(linkedInvoice.date).toLocaleDateString('de-DE')} · {linkedInvoice.status}</div>
                  </div>
                ) : (
                  <div className="rounded-control border border-dashed border-border-strong px-2.5 py-2 text-caption text-muted">Keine Rechnung verknüpft.</div>
                )}
              </div>

              <div>
                <h3 className={eyebrow}>Aktuelle Buchungszeilen</h3>
                <div className="divide-y divide-border rounded-control border border-border">
                  {previewDraft.lines.map((line) => (
                    <div key={line.id} className="flex items-center justify-between gap-2 px-2.5 py-1.75 text-caption">
                      <span className="min-w-0 truncate text-foreground">{line.accountId} · {line.accountName}</span>
                      <span className="shrink-0 font-mono font-semibold tabular-nums text-foreground">{line.type} {formatCurrency(Number(line.amount), previewTx.currency)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {dataAdapter?.analyzeTransactionDocument ? (
                <div className="flex flex-col gap-2.5">
                  <div>
                    <h3 className="text-eyebrow uppercase text-muted">Beleg mit VLM prüfen</h3>
                    <p className="mt-1 text-caption text-muted">OpenRouter erstellt nur einen Vorschlag. Die Datei wird nur geprüft, nicht an die Buchung angehängt; Belege ordnest du unter Offene Posten zu.</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex h-7 cursor-pointer items-center rounded-control border border-border-strong bg-surface px-2.25 text-caption font-medium text-foreground hover:border-control-border hover:bg-surface-sunken focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring">
                      Datei zur Prüfung wählen
                      <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readVlmDocument(file); }} />
                    </label>
                    {vlmDocument ? <span className="max-w-full truncate text-caption text-muted">{vlmDocument.fileName}</span> : null}
                  </div>
                  {vlmConfig?.configured ? (
                    <Select id="pro-vlm-model" label="Modell" fullWidth value={vlmModel} onChange={(event) => setVlmModel(event.target.value)}>
                      {vlmConfig.models.map((model) => <option key={model} value={model}>{model}</option>)}
                    </Select>
                  ) : <p className="text-caption text-muted">OpenRouter ist auf dieser Verbindung nicht konfiguriert.</p>}
                  <div>
                    <Button variant="secondary" size="sm" onClick={() => void analyzePreviewDocument()} disabled={!vlmConfig?.configured || !vlmDocument || vlmBusy} aria-busy={vlmBusy}>
                      {vlmBusy ? 'Prüfung läuft…' : 'Analysieren'}
                    </Button>
                  </div>
                  {vlmError ? <p className="text-caption text-error-text" role="alert">{vlmError}</p> : null}
                  {vlmAnalysis ? (
                    <div className="flex flex-col gap-2 rounded-control border border-border bg-surface-muted px-2.5 py-2 text-caption">
                      <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-foreground"><span>{vlmAnalysis.extraction.documentType} · {vlmAnalysis.extraction.invoiceNumber ?? 'ohne Nummer'}</span><span>{vlmAnalysis.metadata.model}</span></div>
                      <div className="grid grid-cols-2 gap-1 text-muted">
                        <span className="inline-flex items-center gap-1">Betrag: {vlmAnalysis.deterministicChecks.amountMatches ? (<><CheckCircle2 size={12} aria-hidden="true" className="text-success-text" /> passend</>) : (<><TriangleAlert size={12} aria-hidden="true" className="text-warning-text" /> prüfen</>)}</span>
                        <span className="inline-flex items-center gap-1">Währung: {vlmAnalysis.deterministicChecks.currencyMatches ? (<><CheckCircle2 size={12} aria-hidden="true" className="text-success-text" /> passend</>) : (<><TriangleAlert size={12} aria-hidden="true" className="text-warning-text" /> prüfen</>)}</span>
                        <span>Provider: {formatEmptyValue(vlmAnalysis.metadata.provider)}</span>
                        <span className="tabular-nums">Evidence: {vlmAnalysis.extraction.evidence.length}</span>
                      </div>
                      {vlmAnalysis.extraction.warnings.length > 0 ? <p className="text-warning-text">{vlmAnalysis.extraction.warnings.join(' ')}</p> : null}
                      {previewAccountEditable && canMutate ? <div><Button variant="secondary" size="sm" onClick={() => void applyVlmToDraft()}>Auf Entwurf anwenden</Button></div> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div>
                <h3 className={eyebrow}>Schnellbuchung</h3>
                <div className="flex flex-col gap-2.5">
                  {!previewBankAccountNumber && (
                    <p className="text-caption text-error-text" role="alert">
                      Bankkonto ist nicht konfiguriert. Schnellbuchung ist deaktiviert.
                    </p>
                  )}
                  <AccountCombobox
                    label="Konto"
                    accounts={accountOptions}
                    valueAccountId={previewCounterLine?.accountId ?? ''}
                    valueAccountName={previewCounterLine?.accountName ?? ''}
                    disabled={!previewAccountEditable || !previewBankAccountNumber || !canMutate}
                    onSelect={(account) =>
                      updateInboxAccount(previewTx.id, account.number, account.name, account.defaultTaxCode)
                    }
                  />

                  <Select
                    id="inboxview-steuerfall"
                    label="Steuerfall"
                    fullWidth
                    value={normalizeTaxCaseKey(previewCounterLine?.taxCaseKey ?? previewCounterLine?.taxCode) ?? ''}
                    disabled={!previewAccountEditable || !previewBankAccountNumber || !canMutate}
                    onChange={(e) => updateInboxTaxCase(previewTx.id, e.target.value)}
                  >
                    <option value="">Keine</option>
                    {TAX_CASE_OPTIONS.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </Select>

                  <Textarea
                    id="inboxview-notiz"
                    label="Notiz"
                    fullWidth
                    rows={3}
                    className="min-h-0 resize-none"
                    value={notesEdits[previewTx.id] ?? ''}
                    onChange={(e) =>
                      setNotesEdits((prev) => ({ ...prev, [previewTx.id]: e.target.value }))
                    }
                    disabled={!previewAccountEditable || !canMutate}
                    placeholder="Optionale Notiz..."
                  />

                  <Input
                    id="inboxview-buchungstext-bearbeiten"
                    label="Buchungstext bearbeiten"
                    type="text"
                    fullWidth
                    value={bookingTextEdits[previewTx.id] ?? previewDraft.bookingText ?? ''}
                    disabled={!previewAccountEditable || !canMutate}
                    onChange={(e) =>
                      setBookingTextEdits((prev) => ({ ...prev, [previewTx.id]: e.target.value }))
                    }
                    onBlur={() => commitInboxBookingText(previewTx.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    placeholder="Buchungstext eingeben"
                  />
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border p-3">
              <Button variant="secondary" onClick={() => onOpenTransaction(previewTx.id)}>
                Erweitern
              </Button>
              {!previewPrimaryAction && previewAllowedActions.includes('reverse') ? (
                // The Storno asks for a reason, so it runs from the full editor's confirmation.
                <Button className="flex-1" variant="secondary" onClick={() => onOpenTransaction(previewTx.id)}>
                  Stornieren …
                </Button>
              ) : (
                <Button className="flex-1" onClick={() => handleInlineAction(previewTx)} disabled={!previewPrimaryAction}>
                  {previewPrimaryAction ? nextActionLabel(previewPrimaryAction) : previewTx.isVirtualPosted ? 'Storno unter Offene Posten' : 'Keine Aktion'}
                </Button>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
