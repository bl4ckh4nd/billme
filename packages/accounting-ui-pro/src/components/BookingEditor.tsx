import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  FileText,
  Lock,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { defaultBookingPolicy } from '../domain/policies';
import { WORKFLOW_STEPS, getStatusPresentation, getWorkflowStep } from '../domain/selectors';
import { findTaxCaseOption, normalizeTaxCaseKey, TAX_CASE_OPTIONS, toLegacyTaxCode } from '../domain/taxCases';
import { hasBlockingIssues, validateBookingDraft } from '../domain/validation';
import { getAllowedActions } from '../domain/workflow';
import { permissionContextForRole } from '../mocks/users';
import { useAccountingWorkspace, useWorkspaceLifetime } from '../AccountingWorkspaceContext';
import { Badge, ConfirmDialog, Modal, Stepper } from '@billme/ui';
import { BOOKING_TEMPLATES } from '../domain/bookingTemplates';
import { Account, BookingAction, BookingDraft, JournalLine, Transaction, UserRole } from '../types';
import AccountCombobox from './AccountCombobox';
import ActivityTimeline from './ActivityTimeline';
import ValidationSummary from './ValidationSummary';
import WorkflowActionBar from './WorkflowActionBar';

interface BookingEditorProps {
  transactionId: string | null;
  role: UserRole;
  accounts?: Account[];
  onBack: () => void;
  /** Reports whether the draft differs from the stored one, so the workbench can guard a switch. */
  onDirtyChange?: (dirty: boolean) => void;
  onStoreChange: () => void;
}

function formatCurrency(amount: number | string, currency: string) {
  const num = typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount;
  const safe = Number.isFinite(num) ? num : 0;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(safe);
}

function parseAmountInput(value: string) {
  return value.replace(',', '.');
}

const LIVE_CHECKED_CODES = new Set(['MISSING_POSTING_DATE', 'MISSING_BOOKING_TEXT', 'MISSING_ACCOUNT', 'INVALID_AMOUNT_FORMAT', 'UNBALANCED_ENTRY']);

function actionRequiresConfirmation(action: BookingAction) {
  return action === 'reverse' || action === 'reject';
}

export default function BookingEditor({ transactionId, role, accounts, onBack, onStoreChange, onDirtyChange }: BookingEditorProps) {
  const editorId = useId();
  const store = useAccountingWorkspace();
  const captureLifetime = useWorkspaceLifetime(transactionId);
  const { dispatchBookingAction, getBookingDraftByTransactionId, getTransactionById, saveDraft } = store;
  const accountOptions = accounts ?? store.listAccounts();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const shortcutCloseRef = useRef<HTMLButtonElement>(null);
  const [announceMessage, setAnnounceMessage] = useState('');
  const [announceKind, setAnnounceKind] = useState<'success' | 'error' | null>(null);
  const [confirmationAction, setConfirmationAction] = useState<BookingAction | null>(null);
  const [confirmationReason, setConfirmationReason] = useState('');

  useEffect(() => {
    if (!transactionId) return;
    setTransaction(getTransactionById(transactionId) ?? null);
    setDraft(getBookingDraftByTransactionId(transactionId) ?? null);
  }, [transactionId]);

  useEffect(() => {
    if (!onDirtyChange || !transactionId) return;
    const stored = getBookingDraftByTransactionId(transactionId);
    onDirtyChange(Boolean(draft && stored && JSON.stringify(draft) !== JSON.stringify(stored)));
  }, [draft, onDirtyChange, transactionId]);

  const permissionCtx = permissionContextForRole(role);
  const validationIssues = useMemo(() => {
    if (!transaction || !draft) return [];
    return validateBookingDraft(draft, transaction, defaultBookingPolicy);
  }, [draft, transaction]);

  const allowedActions = useMemo(() => {
    if (!draft) return [];
    const actions = getAllowedActions(draft.workflowStatus, permissionCtx, validationIssues);
    const readOnlyActions = new Set<BookingAction>();
    if (draft.workflowStatus === 'posted' || draft.workflowStatus === 'reversed') readOnlyActions.add('save_draft');
    if (transaction?.isVirtualPosted) {
      readOnlyActions.add('reverse');
      readOnlyActions.add('create_correction');
    }
    return actions.filter((action) => !readOnlyActions.has(action));
  }, [draft, permissionCtx, transaction, validationIssues]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The shortcut dialog itself is a Modal: it owns Escape and the focus trap.
      if (showShortcutHelp) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]') || target?.isContentEditable) return;
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcutHelp((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const primary = allowedActions.find((a) => ['post', 'approve', 'submit_for_review'].includes(a));
        // A hard error blocks the step; the shortcut must not fire what the button shows as locked.
        if (primary && (primary === 'approve' || !hasBlockingIssues(validationIssues))) {
          void handleWorkflowAction(primary);
        }
      }
      if (e.key === 'Escape') {
        setShowShortcutHelp(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [allowedActions, draft, transaction, role, showShortcutHelp, validationIssues]);

  if (!transactionId || !transaction || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        Keine Buchung ausgewählt.
      </div>
    );
  }

  const activeTransactionId = transaction.id;

  const readOnly =
    !permissionCtx.canMutate ||
    draft.workflowStatus === 'posted' ||
    draft.workflowStatus === 'reversed' ||
    (draft.workflowStatus === 'pending_approval' && role === 'bookkeeper');
  const readOnlyMessage =
    draft.workflowStatus === 'posted' || draft.workflowStatus === 'reversed'
      ? 'Gebuchte Buchungen sind gesperrt. Änderungen sind nur über eine Korrektur möglich.'
      : 'Diese Buchung ist schreibgeschützt.';

  const totalSoll = draft.lines
    .filter((line) => line.type === 'Soll')
    .reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const totalHaben = draft.lines
    .filter((line) => line.type === 'Haben')
    .reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const difference = Math.abs(totalSoll - totalHaben);
  const blocking = hasBlockingIssues(validationIssues);
  // Server-only checks (closed period, tax mapping, evidence) arrive on the stored draft; the ones the
  // editor recomputes live are taken from the current input, so a fixed field unblocks at once.
  const clientBlocking = validationIssues.filter((issue) => issue.blocking);
  const blockingIssues = [
    ...clientBlocking,
    ...draft.validationIssues.filter((issue) =>
      issue.blocking && !LIVE_CHECKED_CODES.has(issue.code) && !clientBlocking.some((own) => own.code === issue.code)),
  ];
  if (draft.workflowStatus === 'period_locked' && blockingIssues.length === 0) {
    blockingIssues.push({ id: 'period-locked', code: 'POSTING_DATE_IN_CLOSED_PERIOD', severity: 'error', message: 'Buchungsdatum liegt in einer gesperrten Periode.', blocking: true, source: 'system' });
  }
  // The next step a hard error holds back: shown disabled with its reason instead of disappearing.
  const blockedAction: BookingAction | undefined =
    blockingIssues.length === 0 || !permissionCtx.canMutate
      ? undefined
      : draft.workflowStatus === 'approved'
        ? permissionCtx.canPost ? 'post' : undefined
        : ['incomplete', 'suggested', 'ready_for_review', 'imported', 'period_locked'].includes(draft.workflowStatus)
          ? 'submit_for_review'
          : undefined;
  const blockedReason = blockingIssues.length === 0
    ? undefined
    : `${blockingIssues[0].message}${blockingIssues.length > 1 ? ` (+${blockingIssues.length - 1} weitere)` : ''}`;
  const chartTemplates = BOOKING_TEMPLATES[draft.chartFramework] ?? [];
  const accountByNumber = new Map(accountOptions.map((account) => [account.number, account]));
  // Bank-booking convention (see createDraftFromTransaction): incoming money debits the bank line, outgoing credits it.
  const bankSide: JournalLine['type'] = Number(transaction?.amount) >= 0 ? 'Soll' : 'Haben';
  const bankLine = draft.lines.find((line) => line.type === bankSide && line.accountId);
  const templates = bankLine
    ? chartTemplates.filter((template) => template.direction === (bankSide === 'Soll' ? 'in' : 'out') && accountByNumber.has(template.accountId))
    : [];
  const statusPresentation = getStatusPresentation(draft.workflowStatus);

  function patchDraft(updater: (prev: BookingDraft) => BookingDraft) {
    setDraft((prev) => (prev ? updater(prev) : prev));
  }

  function updateLine(id: string, updater: (line: JournalLine) => JournalLine) {
    patchDraft((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.id === id ? updater(line) : line)),
    }));
  }

  function addLine() {
    if (readOnly) return;
    patchDraft((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        {
          id: `line-${Date.now()}`,
          accountId: '',
          accountName: '',
          type: 'Soll',
          amount: '',
          taxCode: '',
          taxCaseKey: undefined,
          taxRate: undefined,
          countryCode: '',
          counterpartyVatId: '',
          evidenceType: '',
          evidenceReference: '',
          costCenter: '',
        },
      ],
    }));
  }

  function applyTemplate(index: number) {
    const template = templates[index];
    if (readOnly || !template || !bankLine) return;
    const gross = Math.abs(Number(transaction?.amount) || 0);
    // The bank line stays; only the counter side is replaced by the template account.
    patchDraft((prev) => ({
      ...prev,
      lines: [
        { ...bankLine, amount: gross },
        {
          id: `line-${Date.now()}-template`,
          accountId: template.accountId,
          accountName: accountByNumber.get(template.accountId)?.name ?? template.accountId,
          type: bankSide === 'Soll' ? 'Haben' : 'Soll',
          amount: gross,
          taxCaseKey: template.taxCaseKey,
          taxCode: toLegacyTaxCode(template.taxCaseKey) ?? '',
          taxRate: findTaxCaseOption(template.taxCaseKey)?.defaultRate,
          costCenter: '',
        },
      ],
    }));
  }

  function removeLine(lineId: string) {
    if (readOnly) return;
    patchDraft((prev) => ({
      ...prev,
      lines: prev.lines.length <= 2 ? prev.lines : prev.lines.filter((line) => line.id !== lineId),
    }));
  }

  async function persistDraft(localDraft: BookingDraft) {
    const isCurrent = captureLifetime();
    const generation = store.getGeneration();
    const saved = await saveDraft(localDraft, role);
    if (!isCurrent()) return saved;
    setDraft(generation === store.getGeneration() ? saved : getBookingDraftByTransactionId(activeTransactionId) ?? saved);
    setTransaction(getTransactionById(activeTransactionId) ?? transaction);
    onStoreChange();
    return saved;
  }

  async function executeWorkflowAction(action: BookingAction, reason?: string) {
    if (!draft) return;
    const isCurrent = captureLifetime();
    setBusy(true);
    setAnnounceMessage('');
    setAnnounceKind(null);
    try {
      if (action === 'save_draft') {
        await persistDraft({ ...draft });
        if (!isCurrent()) return;
        setAnnounceMessage('Entwurf gespeichert');
        setAnnounceKind('success');
      } else {
        const saved = await saveDraft({ ...draft }, role);
        if (!isCurrent()) return;
        setDraft(saved);
        const next = await dispatchBookingAction(activeTransactionId, action, {
          role,
          actorName: role,
          ...(action === 'reverse' && reason ? { rejectReason: reason } : {}),
        });
        if (!isCurrent()) return;
        setDraft(next);
        setTransaction(getTransactionById(activeTransactionId) ?? transaction);
        onStoreChange();
        setAnnounceMessage(`Aktion ausgeführt: ${action}`);
        setAnnounceKind('success');
      }
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : 'Aktion fehlgeschlagen';
      setAnnounceMessage(message);
      setAnnounceKind('error');
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  function handleWorkflowAction(action: BookingAction) {
    if (!draft) return;
    if (actionRequiresConfirmation(action)) {
      setConfirmationAction(action);
      setConfirmationReason('');
      return;
    }
    void executeWorkflowAction(action);
  }

  const confirmationCopy = confirmationAction === 'reverse'
    ? {
      title: 'Buchung wirklich stornieren?',
      description: 'Die Buchung wird storniert und kann nicht direkt zurückgesetzt werden.',
      confirmLabel: 'Buchung stornieren',
    }
    : {
      title: 'Freigabe ablehnen?',
      description: 'Die Buchung wird zur Korrektur zurückgegeben.',
      confirmLabel: 'Freigabe ablehnen',
    };

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface">
      {announceMessage ? (
        <div
          className={`mx-4 mt-3 rounded-xl border px-3 py-2 text-sm font-medium ${announceKind === 'error' ? 'border-error-border bg-error-bg text-error-text' : 'border-success-border bg-success-bg text-success-text'}`}
          role={announceKind === 'error' ? 'alert' : 'status'}
          aria-live={announceKind === 'error' ? 'assertive' : 'polite'}
        >
          {announceMessage}
        </div>
      ) : null}

      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0 gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={onBack}
            aria-label="Zurück zur Inbox"
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-border text-muted hover:bg-surface-muted shrink-0"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="w-8 h-8 bg-dark-base rounded-lg flex items-center justify-center text-inverse-foreground shrink-0">
            <FileText size={16} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-foreground truncate">Buchung erfassen</h2>
              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusPresentation.className}`}>
                {statusPresentation.label}
              </span>
              {blocking ? (
                <span className="px-1.5 py-0.5 rounded-full border border-error-text bg-error-bg text-error-text text-xs font-semibold inline-flex items-center gap-0.5">
                  <ShieldAlert size={12} /> Blockiert
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded-full border border-success-text bg-success-bg text-success-text text-xs font-semibold inline-flex items-center gap-0.5">
                  <Check size={12} /> OK
                </span>
              )}
              {readOnly && (
                <span className="px-1.5 py-0.5 rounded-full border border-border bg-border-subtle text-foreground text-xs font-semibold inline-flex items-center gap-0.5">
                  <Lock size={12} /> Read-only
                </span>
              )}
            </div>
            {getWorkflowStep(draft.workflowStatus) >= 0 && (
              <Stepper className="mt-1.5" label="Bearbeitungsstand" steps={[...WORKFLOW_STEPS]} current={getWorkflowStep(draft.workflowStatus)} />
            )}
            {readOnly && <p className="mt-1 text-xs text-muted" role="status">{readOnlyMessage}</p>}
            <p className="text-xs text-muted font-medium mt-0.5">
              {transaction.payee} • {new Date(transaction.date).toLocaleDateString('de-DE')} •{' '}
              {formatCurrency(transaction.amount, transaction.currency)}
            </p>
          </div>
        </div>

        <WorkflowActionBar
          draft={draft}
          permissionCtx={permissionCtx}
          allowedActions={allowedActions}
          onAction={(action) => void handleWorkflowAction(action)}
          isBusy={busy}
          blockedAction={blockedAction}
          blockedReason={blockedReason}
        />
      </div>

      {/* Beside the workbench queue the lines need the width; meta moves beside them only on very wide screens. */}
      {/* Workbench centre and aside: Belegkopf, Buchungssatz and T-Konto in the main column;
          receipt, checks and history beside them (below them on narrower screens). */}
      <div className="grid min-w-0 flex-1 gap-4 overflow-auto p-4 min-[1440px]:grid-cols-[minmax(0,1fr)_300px] min-[1440px]:items-start">
        <div className="flex min-w-0 flex-col gap-4">
        <div className="flex w-full shrink-0 flex-col gap-4">
          <div className="border border-border rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-border bg-surface-muted/50 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Belegkopf</h3>
            </div>
            <div className="grid gap-4 p-4 lg:grid-cols-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block mb-1 text-label text-foreground" htmlFor={`${editorId}-bookingeditor-belegdatum`}>
                    Belegdatum
                  </label>
                  <input id={`${editorId}-bookingeditor-belegdatum`}
                    type="date"
                    value={draft.documentDate ?? ''}
                    disabled={readOnly}
                    onChange={(e) => patchDraft((prev) => ({ ...prev, documentDate: e.target.value }))}
                    className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm disabled:bg-surface-muted"
                  />
                </div>
                <div>
                  <label className="block mb-1 text-label text-foreground">
                    Buchungsdatum *
                  </label>
                  <input
                    type="date"
                    value={draft.postingDate ?? ''}
                    disabled={readOnly}
                    onChange={(e) => patchDraft((prev) => ({ ...prev, postingDate: e.target.value }))}
                    className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm disabled:bg-surface-muted"
                  />
                </div>
              </div>

              <div>
                <label className="block mb-1 text-label text-foreground" htmlFor={`${editorId}-bookingeditor-buchungstext`}>
                  Buchungstext *
                </label>
                <input id={`${editorId}-bookingeditor-buchungstext`}
                  type="text"
                  value={draft.bookingText}
                  disabled={readOnly}
                  onChange={(e) => patchDraft((prev) => ({ ...prev, bookingText: e.target.value }))}
                  className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm disabled:bg-surface-muted"
                />
              </div>

              <div>
                <label className="block mb-1 text-label text-foreground">
                  Referenz / Belegnummer
                </label>
                <input
                  type="text"
                  value={draft.externalReference ?? ''}
                  disabled={readOnly}
                  onChange={(e) => patchDraft((prev) => ({ ...prev, externalReference: e.target.value }))}
                  className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm disabled:bg-surface-muted"
                />
              </div>

            </div>
          </div>

        </div>

        <div className="flex min-w-0 flex-col">

          {/* Kartenrumpf: Kopfleiste, Fußleiste und mindestens eine Buchungszeile bleiben immer sichtbar, der Rest scrollt.
              min-h-26 = Spaltenkopf (41px) + eine Zeile (57px); min-h-55 = das plus Kopf- und Fußleiste. */}
          <div className="border border-border rounded-xl overflow-hidden flex-1 flex flex-col min-h-55">
            <div className="p-4 border-b border-border bg-surface-muted flex items-center justify-between shrink-0">
              <h3 className="text-sm font-semibold text-foreground">Buchungssatz</h3>
              <div className="flex items-center gap-3">
                {!readOnly && templates.length > 0 && (
                  <>
                    <label className="sr-only" htmlFor={`${editorId}-booking-template`}>Buchungsvorlage</label>
                    <select
                      id={`${editorId}-booking-template`}
                      value=""
                      onChange={(e) => {
                        if (e.target.value !== '') applyTemplate(Number(e.target.value));
                      }}
                      className="px-2.5 h-8 hover:border-control-border-hover border border-control-border rounded-control bg-surface text-sm"
                    >
                      <option value="">Vorlage einsetzen…</option>
                      {templates.map((template, index) => (
                        <option key={template.label} value={index}>
                          {template.label} ({bankSide === 'Soll' ? `${bankLine?.accountId} an ${template.accountId}` : `${template.accountId} an ${bankLine?.accountId}`})
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <div className="text-xs text-muted font-medium">
                  {draft.lines.length} Zeilen • {blocking ? 'Blocker vorhanden' : 'Prüfbar'}
                </div>
              </div>
            </div>

            <div className="overflow-auto flex-1 min-h-26">
              <div className="sticky top-0 z-10 grid grid-cols-12 gap-3 bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted border-b border-border">
                <div className="col-span-1">S/H</div>
                <div className="col-span-4">Konto</div>
                <div className="col-span-2">KSt.</div>
                <div className="col-span-2">Steuerfall</div>
                <div className="col-span-2 text-right">Betrag</div>
                <div className="col-span-1 text-right"><span className="sr-only">Zeile entfernen</span></div>
              </div>

              <div className="divide-y divide-border-subtle">
                {draft.lines.map((line) => {
                  const selectedTaxCaseKey = normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode);
                  const selectedTaxCase = findTaxCaseOption(selectedTaxCaseKey);
                  // The line books gross; the tax part is split off automatically from the tax case at posting.
                  const autoTaxRate = line.taxRate ?? selectedTaxCase?.defaultRate ?? 0;
                  const lineGross = Number(line.amount) || 0;
                  // Reverse charge adds tax on top of the net line (input and output); standard VAT sits inside the gross.
                  const reverseCharge = /(^|_)RC(_|$)/.test(selectedTaxCase?.key ?? '');
                  // Same rounding as the server's enrichTaxFields, from the amount as currently typed.
                  const round2 = (value: number) => Math.round(value * 100) / 100;
                  const autoTaxAmount = reverseCharge
                    ? round2(lineGross * (autoTaxRate / 100))
                    : round2(lineGross - round2(lineGross / (1 + autoTaxRate / 100)));
                  const autoTaxLabel = reverseCharge
                    ? `Vorsteuer und Umsatzsteuer ${autoTaxRate} % (Reverse Charge)`
                    : `${line.type === 'Soll' ? 'Vorsteuer' : 'Umsatzsteuer'} ${autoTaxRate} %`;
                  return (
                    <div key={line.id} className="px-4 py-3 space-y-3">
                      <div className="grid grid-cols-12 gap-3 items-center">
                        <div className="col-span-1">
                          {/* Two-state switch: the side is a binary fact, not a list choice. */}
                          <div role="radiogroup" aria-label="Soll oder Haben" className="inline-flex h-8 overflow-hidden rounded-control border border-control-border">
                            {(['Soll', 'Haben'] as const).map((side) => (
                              <button
                                key={side}
                                type="button"
                                role="radio"
                                aria-checked={line.type === side}
                                aria-label={side}
                                disabled={readOnly}
                                onClick={() => updateLine(line.id, (current) => ({ ...current, type: side }))}
                                className={`w-7 text-xs font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed ${line.type === side ? 'bg-selected text-selected-foreground' : 'bg-surface text-muted hover:text-foreground'} ${side === 'Haben' ? 'border-l border-border' : ''}`}
                              >
                                {side === 'Soll' ? 'S' : 'H'}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="col-span-4">
                          <AccountCombobox
                            accounts={accountOptions}
                            valueAccountId={line.accountId}
                            valueAccountName={line.accountName}
                            disabled={readOnly}
                            onSelect={(account) =>
                              updateLine(line.id, (current) => {
                                const normalized = normalizeTaxCaseKey(current.taxCaseKey ?? current.taxCode ?? account.defaultTaxCode);
                                const def = findTaxCaseOption(normalized);
                                return {
                                  ...current,
                                  accountId: account.number,
                                  accountName: account.name,
                                  taxCaseKey: normalized,
                                  taxCode: toLegacyTaxCode(normalized) ?? current.taxCode ?? account.defaultTaxCode ?? '',
                                  taxRate: current.taxRate ?? def?.defaultRate,
                                };
                              })
                            }
                          />
                        </div>

                        <div className="col-span-2">
                          <label className="sr-only" htmlFor={`${editorId}-cost-center-${line.id}`}>
                            Kostenstelle
                          </label>
                          <input
                            id={`${editorId}-cost-center-${line.id}`}
                            type="text"
                            value={line.costCenter ?? ''}
                            disabled={readOnly}
                            onChange={(e) => updateLine(line.id, (current) => ({ ...current, costCenter: e.target.value }))}
                            className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm disabled:bg-surface-muted"
                            placeholder="-"
                          />
                        </div>

                        <div className="col-span-2">
                          <label className="sr-only" htmlFor={`${editorId}-tax-case-${line.id}`}>
                            Steuerfall
                          </label>
                          <select
                            id={`${editorId}-tax-case-${line.id}`}
                            value={selectedTaxCaseKey ?? ''}
                            disabled={readOnly}
                            onChange={(e) =>
                              updateLine(line.id, (current) => {
                                const nextTaxCase = normalizeTaxCaseKey(e.target.value);
                                const nextOption = findTaxCaseOption(nextTaxCase);
                                return {
                                  ...current,
                                  taxCaseKey: nextTaxCase,
                                  taxCode: toLegacyTaxCode(nextTaxCase) ?? (nextTaxCase ?? ''),
                                  taxRate: nextTaxCase ? current.taxRate ?? nextOption?.defaultRate : undefined,
                                };
                              })
                            }
                            className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm disabled:bg-surface-muted"
                          >
                            <option value="">Keine</option>
                            {TAX_CASE_OPTIONS.map((option) => (
                              <option key={option.key} value={option.key}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="col-span-2">
                          <label className="sr-only" htmlFor={`${editorId}-amount-${line.id}`}>
                            Betrag
                          </label>
                          <input
                            id={`${editorId}-amount-${line.id}`}
                            type="number"
                            step="0.01"
                            min="0"
                            value={line.amount}
                            disabled={readOnly}
                            onChange={(e) =>
                              updateLine(line.id, (current) => ({ ...current, amount: parseAmountInput(e.target.value) }))
                            }
                            className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm tabular-nums text-right disabled:bg-surface-muted"
                          />
                        </div>

                        <div className="col-span-1 flex justify-end">
                          <button
                            onClick={() => removeLine(line.id)}
                            disabled={readOnly || draft.lines.length <= 2}
                            className="p-2 rounded-lg text-muted hover:text-error-text hover:bg-error-bg disabled:opacity-40"
                            aria-label="Zeile löschen"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      {selectedTaxCase && autoTaxRate > 0 && lineGross > 0 && (
                        <div
                          role="note"
                          aria-label={`Steuer automatisch: ${autoTaxLabel}`}
                          data-auto-tax-line
                          className="flex flex-wrap items-center gap-2 pl-[calc(8.333%+0.75rem)] text-xs text-muted"
                        >
                          <Badge tone="info">Steuer automatisch</Badge>
                          <span>
                            {reverseCharge ? '' : 'davon '}{autoTaxLabel} aus dem Steuerfall:{' '}
                            <span className="font-semibold tabular-nums text-foreground">{formatCurrency(autoTaxAmount, transaction.currency)}</span>
                          </span>
                        </div>
                      )}

                      {selectedTaxCase && (
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                          <div>
                            <label className="block mb-1 text-label text-foreground">
                              Steuersatz %
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={line.taxRate ?? ''}
                              disabled={readOnly}
                              onChange={(e) =>
                                updateLine(line.id, (current) => ({
                                  ...current,
                                  taxRate: e.target.value === '' ? undefined : Number(parseAmountInput(e.target.value)),
                                }))
                              }
                              className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm tabular-nums disabled:bg-surface-muted"
                            />
                          </div>
                          <div>
                            <label className="block mb-1 text-label text-foreground">
                              Land
                            </label>
                            <input
                              type="text"
                              value={line.countryCode ?? ''}
                              disabled={readOnly}
                              onChange={(e) =>
                                updateLine(line.id, (current) => ({
                                  ...current,
                                  countryCode: e.target.value.toUpperCase(),
                                }))
                              }
                              placeholder={selectedTaxCase.requiresCountry ? 'Pflicht (z.B. FR)' : 'Optional'}
                              className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm tabular-nums disabled:bg-surface-muted"
                            />
                          </div>
                          <div>
                            <label className="block mb-1 text-label text-foreground">
                              USt-IdNr.
                            </label>
                            <input
                              type="text"
                              value={line.counterpartyVatId ?? ''}
                              disabled={readOnly}
                              onChange={(e) =>
                                updateLine(line.id, (current) => ({
                                  ...current,
                                  counterpartyVatId: e.target.value.toUpperCase(),
                                }))
                              }
                              placeholder={selectedTaxCase.requiresCounterpartyVatId ? 'Pflicht' : 'Optional'}
                              className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm tabular-nums disabled:bg-surface-muted"
                            />
                          </div>
                          <div>
                            <label className="block mb-1 text-label text-foreground">
                              Nachweisart
                            </label>
                            <input
                              type="text"
                              value={line.evidenceType ?? ''}
                              disabled={readOnly}
                              onChange={(e) => updateLine(line.id, (current) => ({ ...current, evidenceType: e.target.value }))}
                              placeholder={selectedTaxCase.requiresEvidence ? 'Pflicht' : 'Optional'}
                              className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm tabular-nums disabled:bg-surface-muted"
                            />
                          </div>
                          <div>
                            <label className="block mb-1 text-label text-foreground">
                              Nachweis-Referenz
                            </label>
                            <input
                              type="text"
                              value={line.evidenceReference ?? ''}
                              disabled={readOnly}
                              onChange={(e) =>
                                updateLine(line.id, (current) => ({ ...current, evidenceReference: e.target.value }))
                              }
                              placeholder={selectedTaxCase.requiresEvidence ? 'Pflicht' : 'Optional'}
                              className="px-2.5 h-8 hover:border-control-border-hover w-full border border-control-border rounded-control text-sm tabular-nums disabled:bg-surface-muted"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-3 border-t border-border bg-surface-muted/50 flex items-center justify-between shrink-0">
              <button
                onClick={addLine}
                disabled={readOnly}
                className="px-4 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted disabled:opacity-50 inline-flex items-center gap-1"
              >
                <Plus size={16} />
                Zeile hinzufügen
              </button>
              {!readOnly && (
                <button
                  onClick={() => void handleWorkflowAction('save_draft')}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted inline-flex items-center gap-1"
                >
                  <Save size={16} />
                  Speichern
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 shrink-0">
            {/* T-Konto: one figure split into its two sides, the difference named in euros. */}
            <section aria-label="Summen Soll und Haben" className="rounded-2xl border border-border bg-surface p-5">
              <div className="grid grid-cols-[1fr_1px_1fr] border-t border-control-border pt-3">
                <div className="pr-4">
                  <div className="text-caption font-semibold uppercase tracking-[0.04em] text-muted">Soll</div>
                  <div className="text-xl font-semibold tabular-nums text-foreground">{formatCurrency(totalSoll, transaction.currency)}</div>
                </div>
                <div className="bg-control-border" aria-hidden="true" />
                <div className="pl-4 text-right">
                  <div className="text-caption font-semibold uppercase tracking-[0.04em] text-muted">Haben</div>
                  <div className="text-xl font-semibold tabular-nums text-foreground">{formatCurrency(totalHaben, transaction.currency)}</div>
                </div>
              </div>
              <div
                className={`mt-4 flex items-center justify-between rounded-control border px-3 py-2 text-label ${difference < 0.01 ? 'border-success-border bg-success-bg text-success-text' : 'border-error-border bg-error-bg text-error-text'}`}
                role="status"
              >
                <span>{difference < 0.01 ? 'Soll und Haben gleichen sich aus' : 'Differenz, Buchung nicht ausgeglichen'}</span>
                <span className="font-semibold tabular-nums">{formatCurrency(difference, transaction.currency)}</span>
              </div>
            </section>
          </div>
        </div>
        </div>

        <aside aria-label="Beleg, Prüfungen und Verlauf" className="flex min-w-0 flex-col gap-4">
          <section aria-label="Beleg" className="rounded-2xl border border-border bg-surface p-4">
            <div className="text-caption font-semibold uppercase tracking-[0.04em] text-muted">Beleg</div>
            <div className={`mt-1 text-sm font-semibold ${transaction.hasReceipt ? 'text-success-text' : 'text-warning-text'}`}>
              {transaction.hasReceipt ? 'Beleg vorhanden' : 'Beleg fehlt'}
            </div>
            <div className="mt-3 text-caption font-semibold uppercase tracking-[0.04em] text-muted">Kontenrahmen</div>
            <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">{draft.chartFramework}</div>
          </section>
          <ValidationSummary issues={validationIssues} />
          <ActivityTimeline events={draft.activity} />
        </aside>
      </div>

      <Modal
        open={showShortcutHelp}
        onClose={() => setShowShortcutHelp(false)}
        titleId={`${editorId}-shortcut-help-title`}
        initialFocusRef={shortcutCloseRef}
        className="max-w-lg rounded-2xl border border-border p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id={`${editorId}-shortcut-help-title`} className="text-base font-semibold text-foreground">Tastenkürzel</h3>
          <button ref={shortcutCloseRef} aria-label="Schließen (Tastenkürzel-Hilfe)" onClick={() => setShowShortcutHelp(false)} className="text-sm font-semibold text-muted">
            Schließen
          </button>
        </div>
        <ul className="space-y-2 text-sm text-foreground">
          <li><strong>Ctrl/Cmd + Enter</strong>: Primäraktion ausführen (z. B. Freigeben/Buchen)</li>
          <li><strong>?</strong>: Shortcut-Hilfe öffnen/schließen</li>
          <li><strong>Esc</strong>: Dialog schließen</li>
        </ul>
      </Modal>

      <ConfirmDialog
        open={confirmationAction !== null}
        title={confirmationCopy.title}
        description={confirmationCopy.description}
        confirmLabel={confirmationCopy.confirmLabel}
        cancelLabel="Abbrechen"
        destructive
        busy={busy}
        reason={confirmationAction === 'reverse' ? {
          label: 'Grund (Pflicht)',
          placeholder: 'Warum wird diese Buchung storniert?',
          required: true,
          value: confirmationReason,
          onChange: setConfirmationReason,
        } : undefined}
        details={confirmationAction === 'reverse' ? (
          <div className="space-y-2" aria-label="Buchung, die storniert wird">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Betrag</div>
                <div className="font-semibold tabular-nums text-foreground">{formatCurrency(transaction.amount, transaction.currency)}</div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Soll / Haben</div>
                <div className="font-semibold tabular-nums text-foreground">
                  {formatCurrency(totalSoll, transaction.currency)} / {formatCurrency(totalHaben, transaction.currency)}
                </div>
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Konten und Seiten</div>
              <ul className="mt-1 space-y-1 text-sm text-foreground">
                {draft.lines.map((line) => (
                  <li key={line.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{line.accountId || line.accountName}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{line.type} · {formatCurrency(Number(line.amount) || 0, transaction.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : undefined}
        onConfirm={() => {
          const action = confirmationAction;
          setConfirmationAction(null);
          const reason = confirmationReason.trim();
          setConfirmationReason('');
          if (action) void executeWorkflowAction(action, reason);
        }}
        onCancel={() => {
          setConfirmationAction(null);
          setConfirmationReason('');
        }}
      />
    </div>
  );
}
