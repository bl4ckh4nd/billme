import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, GitBranch, Play, Wand2 } from 'lucide-react';
import { getStatusPresentation } from '../domain/selectors';
import { normalizeTaxCaseKey, toLegacyTaxCode } from '../domain/taxCases';
import { getAllowedActions } from '../domain/workflow';
import { mockAccounts } from '../mocks/accounts';
import { permissionContextForRole } from '../mocks/users';
import { dispatchBookingAction, getBookingDraftByTransactionId, saveDraft } from '../services/mockBookingStore';
import { BookingAction, BookingDraft, JournalLine, Transaction, UserRole } from '../types';
import AccountCombobox from './AccountCombobox';
import IssueBadges from './IssueBadges';

interface ReconciliationWorkbenchProps {
  role: UserRole;
  transactions: Transaction[];
  onOpenTransaction: (transactionId: string) => void;
  onRefresh: () => void;
}

function formatCurrency(amount: number | string, currency: string) {
  const num = typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(Number.isFinite(num) ? num : 0);
}

function getPrimaryAction(actions: BookingAction[]): BookingAction | null {
  return actions.find((a) => ['approve', 'post', 'submit_for_review'].includes(a)) ?? null;
}

export default function ReconciliationWorkbench({
  role,
  transactions,
  onOpenTransaction,
  onRefresh,
}: ReconciliationWorkbenchProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const permissionCtx = permissionContextForRole(role);

  const queue = useMemo(
    () =>
      transactions.filter(
        (tx) => !['posted', 'reversed', 'corrected', 'integration_error'].includes(tx.workflowStatus),
      ),
    [transactions],
  );

  const selectedTx = queue.find((tx) => tx.id === selectedId) ?? queue[0] ?? null;
  const storeDraft = selectedTx ? getBookingDraftByTransactionId(selectedTx.id) : undefined;
  const [localDraft, setLocalDraft] = useState<BookingDraft | null>(null);

  useEffect(() => {
    setLocalDraft(storeDraft ?? null);
  }, [storeDraft?.id, storeDraft?.activity.length]);

  const draft = localDraft ?? storeDraft;
  const allowed = draft ? getAllowedActions(draft.workflowStatus, permissionCtx, draft.validationIssues) : [];
  const primary = getPrimaryAction(allowed);
  const splitTotal = draft
    ? draft.lines.reduce((sum, line) => {
        const value = typeof line.amount === 'string' ? Number(line.amount.replace(',', '.')) : line.amount;
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0)
    : 0;
  const targetTotal = selectedTx ? Math.abs(selectedTx.amount) : 0;
  const splitDifference = Math.abs(splitTotal - targetTotal);
  const expectedBankType = selectedTx ? (selectedTx.amount >= 0 ? 'Soll' : 'Haben') : null;
  const expectedCounterType = expectedBankType === 'Soll' ? 'Haben' : expectedBankType === 'Haben' ? 'Soll' : null;
  const bankLines = draft ? draft.lines.filter((line) => line.accountId === '1200') : [];
  const nonBankLines = draft ? draft.lines.filter((line) => line.accountId !== '1200') : [];
  const bankLine = bankLines[0];
  const bankLineAmount = bankLine
    ? typeof bankLine.amount === 'string'
      ? Number(bankLine.amount.replace(',', '.'))
      : bankLine.amount
    : NaN;
  const nonBankSameDirectionViolation = nonBankLines.some(
    (line) => expectedCounterType && line.accountId && line.type !== expectedCounterType,
  );
  const nonBankCounterTotal = nonBankLines.reduce((sum, line) => {
    const value = typeof line.amount === 'string' ? Number(line.amount.replace(',', '.')) : line.amount;
    if (!Number.isFinite(value)) return sum;
    return expectedCounterType && line.type === expectedCounterType ? sum + value : sum;
  }, 0);
  const directionErrors: string[] = [];
  if (draft && expectedBankType) {
    if (bankLines.length !== 1) {
      directionErrors.push('Es muss genau eine Bankzeile (Konto 1200) vorhanden sein.');
    }
    if (bankLine && bankLine.type !== expectedBankType) {
      directionErrors.push(
        `Bankzeile muss bei ${selectedTx!.amount >= 0 ? 'Eingang' : 'Ausgang'} auf ${expectedBankType} stehen.`,
      );
    }
    if (bankLine && Number.isFinite(bankLineAmount) && Math.abs(bankLineAmount - targetTotal) >= 0.01) {
      directionErrors.push('Betrag der Bankzeile muss dem Bankumsatz entsprechen.');
    }
    if (nonBankSameDirectionViolation) {
      directionErrors.push(`Gegenkonten müssen auf ${expectedCounterType} gebucht werden.`);
    }
    if (Math.abs(nonBankCounterTotal - targetTotal) >= 0.01) {
      directionErrors.push('Summe der Gegenkonten entspricht nicht dem Bankumsatz.');
    }
  }
  const splitIsValid = !draft || (splitDifference < 0.01 && directionErrors.length === 0);

  const runPrimaryAction = () => {
    if (!selectedTx || !primary || !splitIsValid) return;
    try {
      dispatchBookingAction(selectedTx.id, primary, { role, actorName: role });
      onRefresh();
    } catch {
      onOpenTransaction(selectedTx.id);
    }
  };

  const updateLine = (lineId: string, updater: (line: JournalLine) => JournalLine) => {
    setLocalDraft((prev) =>
      prev
        ? {
            ...prev,
            lines: prev.lines.map((line) => (line.id === lineId ? updater(line) : line)),
          }
        : prev,
    );
  };

  const addSplitLine = () => {
    setLocalDraft((prev) =>
      prev
        ? {
            ...prev,
            lines: [
              ...prev.lines,
              {
                id: `split-${Date.now()}`,
                accountId: '',
                accountName: '',
                type: prev.lines[0]?.type === 'Soll' ? 'Soll' : 'Haben',
                amount: '',
                taxCode: '',
                taxCaseKey: undefined,
                costCenter: '',
              },
            ],
          }
        : prev,
    );
  };

  const removeLine = (lineId: string) => {
    setLocalDraft((prev) =>
      prev && prev.lines.length > 2
        ? { ...prev, lines: prev.lines.filter((line) => line.id !== lineId) }
        : prev,
    );
  };

  const saveInlineSplit = () => {
    if (!draft) return;
    saveDraft(draft, role);
    onRefresh();
  };

  return (
    <div className="flex">
      <div className="w-[28rem] shrink-0 border-r border-gray-100 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-black text-accent-lime flex items-center justify-center shrink-0">
              <ArrowRightLeft size={15} />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-black tracking-tight text-gray-900 leading-tight">Bankabgleich Workbench</h1>
              <p className="text-xs text-gray-400 font-medium leading-tight">
                Vorschläge prüfen, matchen und in den Buchungsworkflow überführen.
              </p>
            </div>
          </div>
        </div>
        <div className="overflow-y-auto p-3 space-y-2">
          {queue.map((tx) => {
            const status = getStatusPresentation(tx.workflowStatus);
            return (
              <button
                key={tx.id}
                onClick={() => setSelectedId(tx.id)}
                className={`w-full text-left border rounded-xl p-3 transition-colors ${
                  selectedTx?.id === tx.id
                    ? 'border-black bg-gray-50'
                    : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-bold text-sm text-gray-900 leading-tight">{tx.payee}</div>
                    <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">
                      {new Date(tx.date).toLocaleDateString('de-DE')} • {tx.description}
                    </div>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-[11px] font-bold ${status.className}`}>
                    {status.label}
                  </span>
                </div>
                <div className={`text-xs font-bold mt-1.5 ${tx.amount < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                  {formatCurrency(tx.amount, tx.currency)}
                </div>
                <div className="mt-1.5">
                  <IssueBadges transaction={tx} />
                </div>
              </button>
            );
          })}
          {queue.length === 0 && (
            <div className="border border-gray-200 rounded-xl p-6 text-sm text-gray-500 bg-white">
              Keine offenen Transaktionen im Abgleich.
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 p-6 overflow-y-auto max-h-[56vh]">
        {!selectedTx || !draft ? (
          <div className="text-gray-500">Keine Position ausgewählt.</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-6">
            <section className="space-y-4">
              <div className="border border-gray-200 rounded-2xl bg-white p-5">
                <div className="text-xs uppercase tracking-wider text-gray-400 font-bold">Bankbewegung</div>
                <div className="mt-2 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 items-start">
                  <div className="min-w-0">
                    <div className="font-bold text-base text-gray-900">{selectedTx.payee}</div>
                    <div className="text-sm text-gray-500 line-clamp-2">{selectedTx.description}</div>
                    <div className="text-xs text-gray-400 mt-1">
                      {new Date(selectedTx.date).toLocaleDateString('de-DE')} • {selectedTx.id}
                    </div>
                  </div>
                  <div className={`text-xl font-bold whitespace-nowrap ${selectedTx.amount < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                    {formatCurrency(selectedTx.amount, selectedTx.currency)}
                  </div>
                </div>
                <div className="mt-4">
                  <div className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1">Gegenkonto (Quick)</div>
                  <AccountCombobox
                    accounts={mockAccounts}
                    valueAccountId={draft.lines.find((line) => line.accountId !== '1200')?.accountId ?? ''}
                    valueAccountName={draft.lines.find((line) => line.accountId !== '1200')?.accountName ?? ''}
                    placeholder="Gegenkonto wählen..."
                    onSelect={(account) => {
                      const line = draft.lines.find((item) => item.accountId !== '1200');
                      if (!line) return;
                      updateLine(line.id, (cur) => ({
                        ...cur,
                        accountId: account.number,
                        accountName: account.name,
                        taxCaseKey: normalizeTaxCaseKey(cur.taxCaseKey ?? cur.taxCode ?? account.defaultTaxCode),
                        taxCode:
                          toLegacyTaxCode(normalizeTaxCaseKey(cur.taxCaseKey ?? cur.taxCode ?? account.defaultTaxCode))
                          ?? cur.taxCode
                          ?? account.defaultTaxCode
                          ?? '',
                      }));
                    }}
                  />
                </div>
              </div>

              <div className="border border-gray-200 rounded-2xl bg-white p-5">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold text-gray-900">Matching-Kandidaten (Mock)</div>
                  <span className="text-xs text-gray-500 font-medium">
                    Confidence {Math.round((selectedTx.suggestionConfidence ?? 0.5) * 100)}%
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  <div className="border border-gray-200 rounded-xl p-4 bg-gray-50/50">
                    <div className="flex items-center justify-between">
                      <div className="font-bold text-gray-900">
                        {selectedTx.suggestion ?? 'Kein Vorschlag'}
                      </div>
                      <span className="text-xs font-bold px-2 py-1 rounded-full bg-blue-100 text-blue-700">
                        Regel / Historie
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 mt-2">
                      Entwurf enthält {draft.lines.length} Buchungszeilen und {draft.validationIssues.length} Validierungshinweise.
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={runPrimaryAction}
                        disabled={!primary || !splitIsValid}
                        className="px-4 py-2 rounded-full bg-black text-white text-sm font-bold hover:bg-gray-900 disabled:opacity-40 inline-flex items-center gap-1"
                      >
                        <CheckCircle2 size={14} />
                        {primary ? 'Match & nächste Aktion' : 'Kein Schritt möglich'}
                      </button>
                      <button
                        onClick={() => onOpenTransaction(selectedTx.id)}
                        className="px-4 py-2 rounded-full border border-gray-200 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50"
                      >
                        Im Editor öffnen
                      </button>
                      <button
                        className="px-4 py-2 rounded-full border border-gray-200 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1"
                        onClick={addSplitLine}
                      >
                        <GitBranch size={14} />
                        Split-Zeile hinzufügen
                      </button>
                    </div>
                  </div>
                  {!splitIsValid && (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      <div className="font-bold">Abgleich-Validierung fehlgeschlagen</div>
                      <ul className="mt-1 space-y-1">
                        {splitDifference >= 0.01 && (
                          <li>
                            Split-Summe stimmt nicht mit der Bankbewegung überein. Differenz:{' '}
                            <span className="font-bold">{formatCurrency(splitDifference, selectedTx.currency)}</span>
                          </li>
                        )}
                        {directionErrors.map((msg) => (
                          <li key={msg}>{msg}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <div className="border border-gray-200 rounded-2xl bg-white p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-bold text-gray-900">Entwurf / Split-Bearbeitung inline</div>
                  <button
                    onClick={saveInlineSplit}
                    className="px-3 py-1.5 rounded-full bg-black text-white text-xs font-bold hover:bg-gray-900"
                  >
                    Split speichern
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {draft.lines.map((line) => (
                    <div
                      key={line.id}
                      className="grid grid-cols-12 gap-2 items-center text-sm border border-gray-100 rounded-lg p-2"
                    >
                      <select
                        value={line.type}
                        onChange={(e) =>
                          updateLine(line.id, (cur) => ({ ...cur, type: e.target.value as 'Soll' | 'Haben' }))
                        }
                        className="col-span-2 border border-gray-200 rounded-xl px-2 py-2 text-sm"
                        aria-label="Soll/Haben"
                      >
                        <option value="Soll">Soll</option>
                        <option value="Haben">Haben</option>
                      </select>
                      <div className="col-span-6">
                        <AccountCombobox
                          accounts={mockAccounts}
                          valueAccountId={line.accountId}
                          valueAccountName={line.accountName}
                          onSelect={(account) =>
                            updateLine(line.id, (cur) => ({
                              ...cur,
                              accountId: account.number,
                              accountName: account.name,
                              taxCaseKey: normalizeTaxCaseKey(cur.taxCaseKey ?? cur.taxCode ?? account.defaultTaxCode),
                              taxCode:
                                toLegacyTaxCode(normalizeTaxCaseKey(cur.taxCaseKey ?? cur.taxCode ?? account.defaultTaxCode))
                                ?? cur.taxCode
                                ?? account.defaultTaxCode
                                ?? '',
                            }))
                          }
                        />
                      </div>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.amount}
                        onChange={(e) => updateLine(line.id, (cur) => ({ ...cur, amount: e.target.value }))}
                        className="col-span-3 border border-gray-200 rounded-xl px-2 py-2 text-sm text-right"
                        aria-label="Betrag"
                      />
                      <button
                        onClick={() => removeLine(line.id)}
                        className="col-span-1 text-xs font-bold text-gray-500 hover:text-red-600"
                        aria-label="Zeile entfernen"
                        disabled={draft.lines.length <= 2}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                  <span>{draft.lines.length} Zeilen</span>
                  <span>
                    Split-Summe: {formatCurrency(splitTotal, selectedTx.currency)}
                  </span>
                  <span>
                    Ziel: {formatCurrency(targetTotal, selectedTx.currency)}
                  </span>
                  <span>
                    Richtung: {selectedTx.amount >= 0 ? 'Eingang (Bank Soll)' : 'Ausgang (Bank Haben)'}
                  </span>
                  <span className={splitIsValid ? 'text-emerald-700 font-bold' : 'text-red-700 font-bold'}>
                    {splitIsValid ? 'OK' : `Diff ${formatCurrency(splitDifference, selectedTx.currency)}`}
                  </span>
                </div>
              </div>

              <div className="border border-gray-200 rounded-2xl bg-white p-5">
                <div className="text-sm font-bold text-gray-900 mb-2">Workflow Schnellaktionen</div>
                <div className="flex flex-wrap gap-2">
                  {allowed.map((action) => (
                    <button
                      key={action}
                      onClick={() => {
                        if (!splitIsValid && (action === 'submit_for_review' || action === 'approve' || action === 'post')) {
                          return;
                        }
                        try {
                          dispatchBookingAction(selectedTx.id, action, { role, actorName: role });
                          onRefresh();
                        } catch {
                          onOpenTransaction(selectedTx.id);
                        }
                      }}
                      className="px-3 py-2 rounded-full border border-gray-200 bg-white text-sm font-bold text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1"
                      disabled={!splitIsValid && (action === 'submit_for_review' || action === 'approve' || action === 'post')}
                    >
                      {action === 'post' ? <Play size={13} /> : <Wand2 size={13} />}
                      {action}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
