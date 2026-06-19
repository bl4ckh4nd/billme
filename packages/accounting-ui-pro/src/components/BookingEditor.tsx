import { useEffect, useMemo, useState } from 'react';
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
import { BookingAction, BookingDraft, JournalLine, Transaction, UserRole } from '../types';
import AccountCombobox from './AccountCombobox';
import ActivityTimeline from './ActivityTimeline';
import ValidationSummary from './ValidationSummary';
import WorkflowActionBar from './WorkflowActionBar';

interface BookingEditorProps {
  transactionId: string | null;
  role: UserRole;
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

export default function BookingEditor({ transactionId, role, onBack, onStoreChange }: BookingEditorProps) {
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [showReceipt, setShowReceipt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [announceMessage, setAnnounceMessage] = useState('');

  useEffect(() => {
    if (!transactionId) return;
    setTransaction(getTransactionById(transactionId) ?? null);
    setDraft(getBookingDraftByTransactionId(transactionId) ?? null);
  }, [transactionId]);

  const permissionCtx = permissionContextForRole(role);
  const validationIssues = useMemo(() => {
    if (!transaction || !draft) return [];
    return validateBookingDraft(draft, transaction, defaultBookingPolicy);
  }, [draft, transaction]);

  const allowedActions = useMemo(() => {
    if (!draft) return [];
    return getAllowedActions(draft.workflowStatus, permissionCtx, validationIssues);
  }, [draft, permissionCtx, validationIssues]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
  }, [allowedActions, draft, transaction, role]);

  if (!transactionId || !transaction || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Keine Buchung ausgewählt.
      </div>
    );
  }

  const activeTransactionId = transaction.id;

  const readOnly =
    draft.workflowStatus === 'posted' ||
    draft.workflowStatus === 'reversed' ||
    (draft.workflowStatus === 'pending_approval' && role === 'bookkeeper');

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
    const saved = saveDraft(localDraft, role);
    setDraft(saved);
    setTransaction(getTransactionById(activeTransactionId) ?? transaction);
    onStoreChange();
    return saved;
  }

  async function handleWorkflowAction(action: BookingAction) {
    if (!draft) return;
    if (actionRequiresConfirmation(action)) {
      const ok = window.confirm(
        action === 'reverse'
          ? 'Buchung wirklich stornieren?'
          : 'Freigabe ablehnen und zur Korrektur zurückgeben?',
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      if (action === 'save_draft') {
        await persistDraft({ ...draft });
        setAnnounceMessage('Entwurf gespeichert');
      } else {
        const saved = saveDraft({ ...draft }, role);
        setDraft(saved);
        const next = dispatchBookingAction(activeTransactionId, action, { role, actorName: role });
        setDraft(next);
        setTransaction(getTransactionById(activeTransactionId) ?? transaction);
        onStoreChange();
        setAnnounceMessage(`Aktion ausgeführt: ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Aktion fehlgeschlagen';
      setAnnounceMessage(message);
      window.alert(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="sr-only" aria-live="polite">
        {announceMessage}
      </div>

      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 shrink-0 gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={onBack}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 shrink-0"
          >
            <ArrowLeft size={15} />
          </button>
          <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center text-accent-lime shrink-0">
            <FileText size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-black text-gray-900 truncate">Buchung erfassen</h2>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusPresentation.className}`}>
                {statusPresentation.label}
              </span>
              {blocking ? (
                <span className="px-1.5 py-0.5 rounded-md bg-red-50 text-red-700 text-[10px] font-bold inline-flex items-center gap-0.5">
                  <ShieldAlert size={10} /> Blockiert
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-[10px] font-bold inline-flex items-center gap-0.5">
                  <Check size={10} /> OK
                </span>
              )}
              {readOnly && (
                <span className="px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-700 text-[10px] font-bold inline-flex items-center gap-0.5">
                  <Lock size={10} /> Read-only
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 font-medium mt-0.5">
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

      <div className="flex flex-1 overflow-hidden p-5 gap-5">
        <div className={`flex flex-col gap-4 ${showReceipt ? 'w-[30rem]' : 'w-[22rem]'} shrink-0`}>
          <div className="border border-gray-200 rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-gray-900">Transaktion & Meta</h3>
              <button
                onClick={() => setShowReceipt((v) => !v)}
                className="text-xs font-bold px-3 py-1 rounded-full border border-gray-200 bg-white"
              >
                Beleg {showReceipt ? 'ausblenden' : 'einblenden'}
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">
                    Belegdatum
                  </label>
                  <input
                    type="date"
                    value={draft.documentDate ?? ''}
                    disabled={readOnly}
                    onChange={(e) => patchDraft((prev) => ({ ...prev, documentDate: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm disabled:bg-gray-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">
                    Buchungsdatum *
                  </label>
                  <input
                    type="date"
                    value={draft.postingDate ?? ''}
                    disabled={readOnly}
                    onChange={(e) => patchDraft((prev) => ({ ...prev, postingDate: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm disabled:bg-gray-50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">
                  Buchungstext *
                </label>
                <input
                  type="text"
                  value={draft.bookingText}
                  disabled={readOnly}
                  onChange={(e) => patchDraft((prev) => ({ ...prev, bookingText: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm disabled:bg-gray-50"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">
                  Referenz / Belegnummer
                </label>
                <input
                  type="text"
                  value={draft.externalReference ?? ''}
                  disabled={readOnly}
                  onChange={(e) => patchDraft((prev) => ({ ...prev, externalReference: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm disabled:bg-gray-50"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-gray-200 p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-gray-400">Mandant/Framework</div>
                  <div className="font-bold text-gray-800 mt-1">{draft.chartFramework} (Default)</div>
                </div>
                <div className="rounded-xl border border-gray-200 p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-gray-400">Belegstatus</div>
                  <div className={`font-bold mt-1 ${transaction.hasReceipt ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {transaction.hasReceipt ? 'Beleg vorhanden' : 'Beleg fehlt'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {showReceipt && (
            <div className="border border-gray-200 rounded-2xl overflow-hidden flex-1 min-h-[14rem]">
              <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                <h3 className="text-sm font-bold text-gray-900">Beleg (Mockup)</h3>
                <span className="text-xs font-bold text-gray-500">
                  {transaction.hasReceipt ? 'PDF • 1 Seite' : 'Kein Beleg'}
                </span>
              </div>
              <div className="p-4 h-full">
                <div className="h-full min-h-[12rem] rounded-xl border border-gray-200 bg-gray-50 flex items-center justify-center">
                  {transaction.hasReceipt ? (
                    <img
                      src={`https://picsum.photos/seed/${transaction.id}/360/420?blur=2`}
                      alt="Beleg Vorschau"
                      className="w-full h-full object-cover opacity-60 rounded-xl"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="text-center">
                      <FileText className="mx-auto text-gray-300 mb-2" />
                      <p className="text-sm text-gray-500">Beleg fehlt</p>
                      <button className="mt-2 text-sm font-bold text-black hover:underline">
                        Beleg anfordern
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <ValidationSummary issues={validationIssues} />

          <div className="border border-gray-200 rounded-xl overflow-hidden flex-1 flex flex-col min-h-0">
            <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-gray-900">Buchungssatz</h3>
              <div className="text-xs text-gray-500 font-medium">
                {draft.lines.length} Zeilen • {blocking ? 'Blocker vorhanden' : 'Prüfbar'}
              </div>
            </div>

            <div className="overflow-auto">
              <div className="grid grid-cols-12 gap-3 px-4 py-3 text-xs font-bold uppercase tracking-wide text-gray-500 border-b border-gray-100">
                <div className="col-span-1">S/H</div>
                <div className="col-span-4">Konto</div>
                <div className="col-span-2">KSt.</div>
                <div className="col-span-2">Steuerfall</div>
                <div className="col-span-2 text-right">Betrag</div>
                <div className="col-span-1 text-right">-</div>
              </div>

              <div className="divide-y divide-gray-100">
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
                            className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm disabled:bg-gray-50"
                          >
                            <option value="Soll">Soll</option>
                            <option value="Haben">Haben</option>
                          </select>
                        </div>

                        <div className="col-span-4">
                          <AccountCombobox
                            accounts={mockAccounts}
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
                            className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm disabled:bg-gray-50"
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
                            className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm disabled:bg-gray-50"
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
                            className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm text-right disabled:bg-gray-50"
                          />
                        </div>

                        <div className="col-span-1 flex justify-end">
                          <button
                            onClick={() => removeLine(line.id)}
                            disabled={readOnly || draft.lines.length <= 2}
                            className="p-2 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                            aria-label="Zeile löschen"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      {selectedTaxCase && (
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">
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
                              className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm disabled:bg-gray-50"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">
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
                              className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm disabled:bg-gray-50"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">
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
                              className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm disabled:bg-gray-50"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                              Nachweisart
                            </label>
                            <input
                              type="text"
                              value={line.evidenceType ?? ''}
                              disabled={readOnly}
                              onChange={(e) => updateLine(line.id, (current) => ({ ...current, evidenceType: e.target.value }))}
                              placeholder={selectedTaxCase.requiresEvidence ? 'Pflicht' : 'Optional'}
                              className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm disabled:bg-gray-50"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">
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
                              className="w-full border border-gray-200 rounded-xl px-2 py-2 text-sm disabled:bg-gray-50"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-3 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between">
              <button
                onClick={addLine}
                disabled={readOnly}
                className="px-4 py-2 rounded-full border border-gray-200 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1"
              >
                <Plus size={15} />
                Zeile hinzufügen
              </button>
              <button
                onClick={() => void handleWorkflowAction('save_draft')}
                disabled={busy}
                className="px-4 py-2 rounded-full border border-gray-200 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1"
              >
                <Save size={15} />
                Speichern
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 2xl:grid-cols-[1fr_20rem] gap-4">
            <div className="bg-black rounded-2xl p-5 text-white">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex gap-8">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-gray-400 font-bold">Soll</div>
                    <div className="text-xl font-bold">{formatCurrency(totalSoll, transaction.currency)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-gray-400 font-bold">Haben</div>
                    <div className="text-xl font-bold">{formatCurrency(totalHaben, transaction.currency)}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wider text-gray-400 font-bold">Differenz</div>
                  <div className={`text-2xl font-bold ${difference < 0.01 ? 'text-accent-lime' : 'text-red-400'}`}>
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
        <div className="absolute inset-0 bg-gray-900/40 flex items-center justify-center p-6">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-gray-200 shadow-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900">Shortcuts (MVP)</h3>
              <button onClick={() => setShowShortcutHelp(false)} className="text-sm font-bold text-gray-600">
                Schließen
              </button>
            </div>
            <ul className="space-y-2 text-sm text-gray-700">
              <li><strong>Ctrl/Cmd + Enter</strong> — Primäraktion ausführen (z. B. Freigeben/Buchen)</li>
              <li><strong>?</strong> — Shortcut-Hilfe öffnen/schließen</li>
              <li><strong>Esc</strong> — Dialog schließen</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
