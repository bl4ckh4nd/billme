import { useEffect, useMemo, useRef, useState } from 'react';
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
import { getStatusPresentation } from '../domain/selectors';
import { findTaxCaseOption, normalizeTaxCaseKey, TAX_CASE_OPTIONS, toLegacyTaxCode } from '../domain/taxCases';
import { hasBlockingIssues, validateBookingDraft } from '../domain/validation';
import { getAllowedActions } from '../domain/workflow';
import { mockAccounts } from '../mocks/accounts';
import { permissionContextForRole } from '../mocks/users';
import {
  dispatchBookingAction,
  getBookingDraftByTransactionId,
  getTransactionById,
  saveDraft,
} from '../services/mockBookingStore';
import { ConfirmDialog } from '@billme/ui';
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

function actionRequiresConfirmation(action: BookingAction) {
  return action === 'reverse' || action === 'reject';
}

export default function BookingEditor({ transactionId, role, accounts, onBack, onStoreChange }: BookingEditorProps) {
  const accountOptions = accounts ?? mockAccounts;
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const shortcutCloseRef = useRef<HTMLButtonElement>(null);
  const shortcutDialogRef = useRef<HTMLDivElement>(null);
  const shortcutPreviousFocusRef = useRef<HTMLElement | null>(null);
  const [announceMessage, setAnnounceMessage] = useState('');
  const [announceKind, setAnnounceKind] = useState<'success' | 'error' | null>(null);
  const [confirmationAction, setConfirmationAction] = useState<BookingAction | null>(null);

  useEffect(() => {
    if (!transactionId) return;
    setTransaction(getTransactionById(transactionId) ?? null);
    setDraft(getBookingDraftByTransactionId(transactionId) ?? null);
  }, [transactionId]);

  useEffect(() => {
    if (showShortcutHelp) {
      shortcutPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      shortcutCloseRef.current?.focus();
    } else {
      shortcutPreviousFocusRef.current?.focus();
      shortcutPreviousFocusRef.current = null;
    }
  }, [showShortcutHelp]);

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
      if (showShortcutHelp) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowShortcutHelp(false);
          return;
        }
        if (e.key === 'Tab') {
          const dialogFocusable = shortcutDialogRef.current?.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          const focusable: HTMLElement[] = [];
          dialogFocusable?.forEach((element) => {
            const htmlElement = element as HTMLElement;
            if (!htmlElement.hasAttribute('disabled')) focusable.push(htmlElement);
          });
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]') || target?.isContentEditable) return;
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcutHelp((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const primary = allowedActions.find((a) => ['post', 'approve', 'submit_for_review'].includes(a));
        if (primary) {
          void handleWorkflowAction(primary);
        }
      }
      if (e.key === 'Escape') {
        setShowShortcutHelp(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [allowedActions, draft, transaction, role, showShortcutHelp]);

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

  function removeLine(lineId: string) {
    if (readOnly) return;
    patchDraft((prev) => ({
      ...prev,
      lines: prev.lines.length <= 2 ? prev.lines : prev.lines.filter((line) => line.id !== lineId),
    }));
  }

  async function persistDraft(localDraft: BookingDraft) {
    const saved = await saveDraft(localDraft, role);
    setDraft(saved);
    setTransaction(getTransactionById(activeTransactionId) ?? transaction);
    onStoreChange();
    return saved;
  }

  async function executeWorkflowAction(action: BookingAction) {
    if (!draft) return;
    setBusy(true);
    setAnnounceMessage('');
    setAnnounceKind(null);
    try {
      if (action === 'save_draft') {
        await persistDraft({ ...draft });
        setAnnounceMessage('Entwurf gespeichert');
        setAnnounceKind('success');
      } else {
        const saved = await saveDraft({ ...draft }, role);
        setDraft(saved);
        const next = await dispatchBookingAction(activeTransactionId, action, { role, actorName: role });
        setDraft(next);
        setTransaction(getTransactionById(activeTransactionId) ?? transaction);
        onStoreChange();
        setAnnounceMessage(`Aktion ausgeführt: ${action}`);
        setAnnounceKind('success');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Aktion fehlgeschlagen';
      setAnnounceMessage(message);
      setAnnounceKind('error');
    } finally {
      setBusy(false);
    }
  }

  function handleWorkflowAction(action: BookingAction) {
    if (!draft) return;
    if (actionRequiresConfirmation(action)) {
      setConfirmationAction(action);
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
          className={`mx-4 mt-3 rounded-xl border px-3 py-2 text-sm font-medium ${announceKind === 'error' ? 'border-error-border bg-error-bg text-error' : 'border-success-border bg-success-bg text-success'}`}
          role={announceKind === 'error' ? 'alert' : 'status'}
          aria-live={announceKind === 'error' ? 'assertive' : 'polite'}
        >
          {announceMessage}
        </div>
      ) : null}

      <div className="flex items-center justify-between px-4 py-2.5 border-b border-subtle shrink-0 gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={onBack}
            aria-label="Zurück zur Inbox"
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-border text-muted hover:bg-surface-muted shrink-0"
          >
            <ArrowLeft size={15} />
          </button>
          <div className="w-8 h-8 bg-dark-base rounded-lg flex items-center justify-center text-accent shrink-0">
            <FileText size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-black text-foreground truncate">Buchung erfassen</h2>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusPresentation.className}`}>
                {statusPresentation.label}
              </span>
              {blocking ? (
                <span className="px-1.5 py-0.5 rounded-md bg-error-bg text-error text-[10px] font-bold inline-flex items-center gap-0.5">
                  <ShieldAlert size={10} /> Blockiert
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded-md bg-success-bg text-success text-[10px] font-bold inline-flex items-center gap-0.5">
                  <Check size={10} /> OK
                </span>
              )}
              {readOnly && (
                <span className="px-1.5 py-0.5 rounded-md bg-border-subtle text-foreground text-[10px] font-bold inline-flex items-center gap-0.5">
                  <Lock size={10} /> Read-only
                </span>
              )}
            </div>
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
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-auto p-5 md:flex-row">
        <div className="flex w-full shrink-0 flex-col gap-4 md:w-80">
          <div className="border border-border rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-subtle bg-surface-muted/50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-foreground">Transaktion & Meta</h3>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
                    Belegdatum
                  </label>
                  <input
                    type="date"
                    value={draft.documentDate ?? ''}
                    disabled={readOnly}
                    onChange={(e) => patchDraft((prev) => ({ ...prev, documentDate: e.target.value }))}
                    className="w-full border border-border rounded-xl px-3 py-2 text-sm disabled:bg-surface-muted"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
                    Buchungsdatum *
                  </label>
                  <input
                    type="date"
                    value={draft.postingDate ?? ''}
                    disabled={readOnly}
                    onChange={(e) => patchDraft((prev) => ({ ...prev, postingDate: e.target.value }))}
                    className="w-full border border-border rounded-xl px-3 py-2 text-sm disabled:bg-surface-muted"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
                  Buchungstext *
                </label>
                <input
                  type="text"
                  value={draft.bookingText}
                  disabled={readOnly}
                  onChange={(e) => patchDraft((prev) => ({ ...prev, bookingText: e.target.value }))}
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm disabled:bg-surface-muted"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
                  Referenz / Belegnummer
                </label>
                <input
                  type="text"
                  value={draft.externalReference ?? ''}
                  disabled={readOnly}
                  onChange={(e) => patchDraft((prev) => ({ ...prev, externalReference: e.target.value }))}
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm disabled:bg-surface-muted"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-border p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-muted">Mandant/Framework</div>
                  <div className="font-bold text-foreground mt-1">{draft.chartFramework} (Default)</div>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-muted">Belegstatus</div>
                  <div className={`font-bold mt-1 ${transaction.hasReceipt ? 'text-success' : 'text-warning'}`}>
                    {transaction.hasReceipt ? 'Beleg vorhanden' : 'Beleg fehlt'}
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ValidationSummary issues={validationIssues} />

          <div className="border border-border rounded-xl overflow-hidden flex-1 flex flex-col min-h-0">
            <div className="p-4 border-b border-border bg-surface-muted flex items-center justify-between">
              <h3 className="text-sm font-bold text-foreground">Buchungssatz</h3>
              <div className="text-xs text-muted font-medium">
                {draft.lines.length} Zeilen • {blocking ? 'Blocker vorhanden' : 'Prüfbar'}
              </div>
            </div>

            <div className="overflow-auto">
              <div className="grid grid-cols-12 gap-3 px-4 py-3 text-xs font-bold uppercase tracking-wide text-muted border-b border-subtle">
                <div className="col-span-1">S/H</div>
                <div className="col-span-4">Konto</div>
                <div className="col-span-2">KSt.</div>
                <div className="col-span-2">Steuerfall</div>
                <div className="col-span-2 text-right">Betrag</div>
                <div className="col-span-1 text-right">-</div>
              </div>

              <div className="divide-y divide-border-subtle">
                {draft.lines.map((line) => {
                  const selectedTaxCaseKey = normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode);
                  const selectedTaxCase = findTaxCaseOption(selectedTaxCaseKey);
                  return (
                    <div key={line.id} className="px-4 py-3 space-y-3">
                      <div className="grid grid-cols-12 gap-3 items-center">
                        <div className="col-span-1">
                          <select
                            value={line.type}
                            disabled={readOnly}
                            onChange={(e) => updateLine(line.id, (current) => ({ ...current, type: e.target.value as 'Soll' | 'Haben' }))}
                            className="w-full border border-border rounded-xl px-2 py-2 text-sm disabled:bg-surface-muted"
                          >
                            <option value="Soll">Soll</option>
                            <option value="Haben">Haben</option>
                          </select>
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
                          <label className="sr-only" htmlFor={`cost-center-${line.id}`}>
                            Kostenstelle
                          </label>
                          <input
                            id={`cost-center-${line.id}`}
                            type="text"
                            value={line.costCenter ?? ''}
                            disabled={readOnly}
                            onChange={(e) => updateLine(line.id, (current) => ({ ...current, costCenter: e.target.value }))}
                            className="w-full border border-border rounded-xl px-2 py-2 text-sm disabled:bg-surface-muted"
                            placeholder="-"
                          />
                        </div>

                        <div className="col-span-2">
                          <label className="sr-only" htmlFor={`tax-case-${line.id}`}>
                            Steuerfall
                          </label>
                          <select
                            id={`tax-case-${line.id}`}
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
                            className="w-full border border-border rounded-xl px-2 py-2 text-sm disabled:bg-surface-muted"
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
                          <label className="sr-only" htmlFor={`amount-${line.id}`}>
                            Betrag
                          </label>
                          <input
                            id={`amount-${line.id}`}
                            type="number"
                            step="0.01"
                            min="0"
                            value={line.amount}
                            disabled={readOnly}
                            onChange={(e) =>
                              updateLine(line.id, (current) => ({ ...current, amount: parseAmountInput(e.target.value) }))
                            }
                            className="w-full border border-border rounded-xl px-2 py-2 text-sm text-right disabled:bg-surface-muted"
                          />
                        </div>

                        <div className="col-span-1 flex justify-end">
                          <button
                            onClick={() => removeLine(line.id)}
                            disabled={readOnly || draft.lines.length <= 2}
                            className="p-2 rounded-lg text-muted hover:text-error hover:bg-error-bg disabled:opacity-40"
                            aria-label="Zeile löschen"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      {selectedTaxCase && (
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
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
                              className="w-full border border-border rounded-xl px-2 py-2 text-sm disabled:bg-surface-muted"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
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
                              className="w-full border border-border rounded-xl px-2 py-2 text-sm disabled:bg-surface-muted"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
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
                              className="w-full border border-border rounded-xl px-2 py-2 text-sm disabled:bg-surface-muted"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
                              Nachweisart
                            </label>
                            <input
                              type="text"
                              value={line.evidenceType ?? ''}
                              disabled={readOnly}
                              onChange={(e) => updateLine(line.id, (current) => ({ ...current, evidenceType: e.target.value }))}
                              placeholder={selectedTaxCase.requiresEvidence ? 'Pflicht' : 'Optional'}
                              className="w-full border border-border rounded-xl px-2 py-2 text-sm disabled:bg-surface-muted"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
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
                              className="w-full border border-border rounded-xl px-2 py-2 text-sm disabled:bg-surface-muted"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-3 border-t border-subtle bg-surface-muted/50 flex items-center justify-between">
              <button
                onClick={addLine}
                disabled={readOnly}
                className="px-4 py-2 rounded-full border border-border bg-surface text-sm font-bold text-foreground hover:bg-surface-muted disabled:opacity-50 inline-flex items-center gap-1"
              >
                <Plus size={15} />
                Zeile hinzufügen
              </button>
              {!readOnly && (
                <button
                  onClick={() => void handleWorkflowAction('save_draft')}
                  disabled={busy}
                  className="px-4 py-2 rounded-full border border-border bg-surface text-sm font-bold text-foreground hover:bg-surface-muted inline-flex items-center gap-1"
                >
                  <Save size={15} />
                  Speichern
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 2xl:grid-cols-2 gap-4">
            <div className="bg-dark-base rounded-2xl p-5 text-background">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex gap-8">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted font-bold">Soll</div>
                    <div className="text-xl font-bold">{formatCurrency(totalSoll, transaction.currency)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted font-bold">Haben</div>
                    <div className="text-xl font-bold">{formatCurrency(totalHaben, transaction.currency)}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wider text-muted font-bold">Differenz</div>
                  <div className={`text-2xl font-bold ${difference < 0.01 ? 'text-accent' : 'text-error'}`}>
                    {formatCurrency(difference, transaction.currency)}
                  </div>
                </div>
              </div>
            </div>

            <ActivityTimeline events={draft.activity} />
          </div>
        </div>
      </div>

      {showShortcutHelp && (
        <div className="absolute inset-0 bg-dark-2/40 flex items-center justify-center p-6" role="presentation">
          <div ref={shortcutDialogRef} className="w-full max-w-lg bg-surface rounded-2xl border border-border shadow-xl p-6" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
            <div className="flex items-center justify-between mb-4">
              <h3 id="shortcut-help-title" className="text-lg font-bold text-foreground">Tastenkürzel</h3>
              <button ref={shortcutCloseRef} aria-label="Schließen (Tastenkürzel-Hilfe)" onClick={() => setShowShortcutHelp(false)} className="text-sm font-bold text-muted">
                Schließen
              </button>
            </div>
            <ul className="space-y-2 text-sm text-foreground">
              <li><strong>Ctrl/Cmd + Enter</strong> — Primäraktion ausführen (z. B. Freigeben/Buchen)</li>
              <li><strong>?</strong> — Shortcut-Hilfe öffnen/schließen</li>
              <li><strong>Esc</strong> — Dialog schließen</li>
            </ul>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmationAction !== null}
        title={confirmationCopy.title}
        description={confirmationCopy.description}
        confirmLabel={confirmationCopy.confirmLabel}
        cancelLabel="Abbrechen"
        destructive
        busy={busy}
        onConfirm={() => {
          const action = confirmationAction;
          setConfirmationAction(null);
          if (action) void executeWorkflowAction(action);
        }}
        onCancel={() => setConfirmationAction(null)}
      />
    </div>
  );
}
