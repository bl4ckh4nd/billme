import { useEffect, useMemo, useRef, useState } from 'react';
// Lucide is the app's icon set; every glyph here names its own control (ArrowRightLeft = Abgleich,
// Play = buchen, ArrowRight = nächster Workflow-Schritt, GitBranch = Split, CheckCircle2 = bestätigen),
// so the surface carries no decorative or "magic" symbol.
import { ArrowRight, ArrowRightLeft, CheckCircle2, GitBranch, Play } from 'lucide-react';
import { bookingActionLabels, getStatusPresentation } from '../domain/selectors';
import { normalizeTaxCaseKey, toLegacyTaxCode } from '../domain/taxCases';
import { getAllowedActions } from '../domain/workflow';
import { permissionContextForRole } from '../mocks/users';
import { useAccountingWorkspace, useWorkspaceLifetime } from '../AccountingWorkspaceContext';
import { Account, BookingAction, BookingDraft, BookingWorkflowStatus, JournalLine, Transaction, UserRole } from '../types';
import type { AccountSuggestionRuleSummary, InvoiceMatchCandidate, ProAccountingDataAdapter } from '../services/mockBookingStore';
import { Badge, ConfirmDialog, HatchedProgress } from '@billme/ui';
import AccountCombobox from './AccountCombobox';
import IssueBadges from './IssueBadges';

export interface ReconciliationTotals {
  target: number;
  bank: number;
  counterpart: number;
  difference: number;
  bankLineCount: number;
  bankAccountNumber?: string;
}

const amountValue = (amount: number | string) => {
  const value = typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount;
  return Number.isFinite(value) ? Math.abs(value) : 0;
};

export function getBankAccountNumber(
  draft: BookingDraft,
  accounts: Account[] = [],
  configuredBankAccountNumber?: string,
  allowMockHeuristic = accounts.length === 0,
): string | undefined {
  if (configuredBankAccountNumber) return configuredBankAccountNumber;
  if (!allowMockHeuristic) return undefined;
  const bankAccounts = new Set(
    accounts
      .filter((account) => /bank|giro|konto/i.test(`${account.name} ${account.keywords?.join(' ') ?? ''}`))
      .map((account) => account.number),
  );
  return draft.lines.find((line) => bankAccounts.has(line.accountId))?.accountId
    ?? draft.lines.find((line) => /bank|giro|konto/i.test(line.accountName))?.accountId;
}

export const getConfiguredBankAccountNumber = getBankAccountNumber;

export function calculateReconciliationTotals(
  draft: BookingDraft,
  transactionAmount: number,
  accounts: Account[] = [],
  configuredBankAccountNumber?: string,
  allowMockHeuristic = accounts.length === 0,
): ReconciliationTotals {
  const bankAccountNumber = getBankAccountNumber(draft, accounts, configuredBankAccountNumber, allowMockHeuristic);
  const bankLines = bankAccountNumber ? draft.lines.filter((line) => line.accountId === bankAccountNumber) : [];
  const counterpartLines = bankAccountNumber ? draft.lines.filter((line) => line.accountId !== bankAccountNumber) : [];
  const target = Math.abs(transactionAmount);
  const bank = bankLines.reduce((sum, line) => sum + amountValue(line.amount), 0);
  const counterpart = counterpartLines.reduce((sum, line) => sum + amountValue(line.amount), 0);
  return {
    target,
    bank,
    counterpart,
    difference: Math.abs(counterpart - target),
    bankLineCount: bankLines.length,
    bankAccountNumber,
  };
}

interface ReconciliationWorkbenchProps {
  role: UserRole;
  accounts?: Account[];
  bankAccountNumber?: string;
  bankAccountNumberByTransactionId?: Record<string, string>;
  transactions: Transaction[];
  onOpenTransaction: (transactionId: string) => void;
  onRefresh: () => void;
  /** Invoice matching and rule statistics; without them the workbench shows neither. */
  dataAdapter?: ProAccountingDataAdapter;
  /** Opens the host's rule editor. */
  onManageRules?: () => void;
  /** Opens Offene Posten with the invoice preselected, where the payment is settled with a ledger entry. */
  onOpenInvoice?: (invoiceId: string) => void;
}

function formatCurrency(amount: number | string, currency: string) {
  const num = typeof amount === 'string' ? Number(amount.replace(',', '.')) : amount;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(Number.isFinite(num) ? num : 0);
}

const CONFIDENT_THRESHOLD = 0.9;

type ScoredCandidate = InvoiceMatchCandidate & { score: number };

// ponytail: the invoice matcher only reports a confidence bucket, so the score is derived here
// (bucket plus a small bonus per extra reason). Replace once findMatches returns a numeric score.
const CONFIDENCE_SCORE = { high: 0.9, medium: 0.6, low: 0.3 } as const;
function scoreCandidates(candidates: InvoiceMatchCandidate[]): ScoredCandidate[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: Math.min(0.99, CONFIDENCE_SCORE[candidate.confidence] + 0.03 * Math.max(0, candidate.matchReasons.length - 1)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/** Two nearly equal hits are no hit: a person decides instead of a preselection. */
export function isZweifelsfall(candidates: Array<{ score: number }>): boolean {
  return candidates.length > 1 && candidates[0].score > 0.5 && candidates[0].score - candidates[1].score < 0.1;
}

const RULE_STALE_DAYS = 92;
const daysSince = (iso?: string) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : Number.POSITIVE_INFINITY);
const RULE_FIELD_LABELS: Record<AccountSuggestionRuleSummary['field'], string> = { counterparty: 'Gegenpartei', purpose: 'Verwendungszweck', any: 'Gegenpartei oder Zweck' };
const RULE_OPERATOR_LABELS: Record<AccountSuggestionRuleSummary['operator'], string> = { contains: 'enthält', equals: 'ist gleich', startsWith: 'beginnt mit' };

interface SessionMatch {
  label: string;
}

function getPrimaryAction(actions: BookingAction[]): BookingAction | null {
  return actions.find((a) => ['approve', 'post', 'submit_for_review'].includes(a)) ?? null;
}

function actionLabel(action: BookingAction): string {
  return bookingActionLabels[action];
}

export default function ReconciliationWorkbench({
  role,
  accounts,
  bankAccountNumber: configuredBankAccountNumber,
  bankAccountNumberByTransactionId,
  transactions,
  onOpenTransaction,
  onRefresh,
  dataAdapter,
  onManageRules,
  onOpenInvoice,
}: ReconciliationWorkbenchProps) {
  const store = useAccountingWorkspace();
  const captureLifetime = useWorkspaceLifetime();
  const { dispatchBookingAction, getBookingDraftByTransactionId, saveDraft } = store;
  const accountOptions = accounts ?? store.listAccounts();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const permissionCtx = permissionContextForRole(role);
  // ponytail: confirmations of this session live in memory only and are gone after a reload; derive them
  // from the draft activity once the list should survive restarts.
  const [sessionMatches, setSessionMatches] = useState<Record<string, SessionMatch>>({});
  const [candidatesById, setCandidatesById] = useState<Record<string, ScoredCandidate[]>>({});
  const requestedCandidates = useRef(new Set<string>());
  const [rules, setRules] = useState<AccountSuggestionRuleSummary[] | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const canMatchInvoices = Boolean(dataAdapter?.findInvoiceMatches);

  const queue = useMemo(
    () =>
      transactions.filter(
        (tx) =>
          !['posted', 'reversed', 'corrected', 'integration_error'].includes(tx.workflowStatus),
      ),
    [transactions],
  );

  const rememberConfirmation = (transactionId: string, action: BookingAction) => {
    setSessionMatches((prev) => ({
      ...prev,
      [transactionId]: prev[transactionId] ?? { label: actionLabel(action) },
    }));
  };

  // A confident match is one the single-item flow would accept unchanged:
  // high suggestion confidence, no blocking issue, an allowed primary action,
  // exactly one bank line and a balanced split.
  const confident = useMemo(
    () =>
      queue.flatMap((tx) => {
        if ((tx.suggestionConfidence ?? 0) < CONFIDENT_THRESHOLD) return [];
        const txDraft = getBookingDraftByTransactionId(tx.id);
        if (!txDraft || txDraft.validationIssues.some((issue) => issue.blocking)) return [];
        const action = getPrimaryAction(getAllowedActions(txDraft.workflowStatus, permissionCtx, txDraft.validationIssues));
        if (!action) return [];
        const txTotals = calculateReconciliationTotals(
          txDraft,
          tx.amount,
          accounts ?? [],
          bankAccountNumberByTransactionId?.[tx.id] ?? configuredBankAccountNumber,
          accounts === undefined,
        );
        // The draft must book what the suggestion names; otherwise confirming would post an account nobody proposed.
        const counterAccounts = txDraft.lines.map((line) => line.accountId).filter((id) => id && id !== txTotals.bankAccountNumber);
        const followsSuggestion = Boolean(tx.suggestion) && counterAccounts.length > 0 && counterAccounts.every((id) => id === tx.suggestion);
        // A payment two invoices fit almost equally well is not sicher; unchecked payments are not either.
        const candidates = candidatesById[tx.id];
        if (canMatchInvoices && tx.amount > 0 && (!candidates || isZweifelsfall(candidates))) return [];
        return followsSuggestion && txTotals.bankLineCount === 1 && txTotals.difference < 0.01 ? [{ tx, action }] : [];
      }),
    [queue, permissionCtx, accounts, bankAccountNumberByTransactionId, configuredBankAccountNumber, candidatesById, canMatchInvoices],
  );
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const done = transactions.length - queue.length;

  // ponytail: runs the existing per-transaction action in sequence; add a batch
  // route in server-runtime if queues get long enough for this to feel slow.
  const runConfidentBatch = async () => {
    const isCurrent = captureLifetime();
    setBatchOpen(false);
    setMutationBusy(true);
    setMutationError(null);
    const failures: string[] = [];
    for (const { tx, action } of confident) {
      if (!isCurrent()) return;
      try {
        await dispatchBookingAction(tx.id, action, { role, actorName: role });
        rememberConfirmation(tx.id, action);
      } catch (error) {
        failures.push(`${tx.payee}: ${error instanceof Error ? error.message : 'unbekannter Fehler'}`);
      }
    }
    setMutationBusy(false);
    if (!isCurrent()) return;
    setBatchResult(
      failures.length === 0
        ? `${confident.length} sichere Treffer weitergeführt.`
        : `${confident.length - failures.length} weitergeführt, ${failures.length} fehlgeschlagen: ${failures.join('; ')}`,
    );
    onRefresh();
  };

  const selectedTx = queue.find((tx) => tx.id === selectedId) ?? queue[0] ?? null;

  // Invoice candidates for incoming payments: the selected one, and every would-be sicher one so the
  // batch never confirms a Zweifelsfall.
  const candidateIds = [selectedTx, ...queue.filter((tx) => (tx.suggestionConfidence ?? 0) >= CONFIDENT_THRESHOLD)]
    .filter((tx): tx is Transaction => Boolean(tx && tx.amount > 0))
    .map((tx) => tx.id)
    .join('|');
  useEffect(() => {
    const findMatches = dataAdapter?.findInvoiceMatches;
    if (!findMatches || !candidateIds) return;
    for (const id of candidateIds.split('|')) {
      if (requestedCandidates.current.has(id)) continue;
      requestedCandidates.current.add(id);
      findMatches(id)
        .then((candidates) => setCandidatesById((prev) => ({ ...prev, [id]: scoreCandidates(candidates) })))
        // The matcher refuses payments that are already linked; that is "no candidate", not an error.
        .catch(() => setCandidatesById((prev) => ({ ...prev, [id]: [] })));
    }
  }, [dataAdapter, candidateIds]);

  useEffect(() => {
    const listRules = dataAdapter?.listAccountSuggestionRules;
    if (!listRules) return;
    let current = true;
    listRules()
      .then((rows) => { if (current) { setRules(rows); setRulesError(null); } })
      .catch((error) => { if (current) setRulesError(error instanceof Error ? error.message : 'Regeln konnten nicht geladen werden.'); });
    return () => { current = false; };
  }, [dataAdapter, transactions]);
  const storeDraft = selectedTx ? getBookingDraftByTransactionId(selectedTx.id) : undefined;
  const [localDraft, setLocalDraft] = useState<BookingDraft | null>(null);

  useEffect(() => {
    setLocalDraft(storeDraft ?? null);
  }, [storeDraft?.id, storeDraft?.activity.length]);

  const draft = localDraft ?? storeDraft;
  const draftReadOnly = !permissionCtx.canMutate || (!!draft && ['posted', 'reversed'].includes(draft.workflowStatus));
  const allowed = draft ? getAllowedActions(draft.workflowStatus, permissionCtx, draft.validationIssues) : [];
  const primary = getPrimaryAction(allowed);
  const bankAccountNumber = draft
    ? getConfiguredBankAccountNumber(
        draft,
        accounts ?? [],
        bankAccountNumberByTransactionId?.[draft.transactionId] ?? configuredBankAccountNumber,
        accounts === undefined,
      )
    : undefined;
  const totals = draft && selectedTx
    ? calculateReconciliationTotals(
        draft,
        selectedTx.amount,
        accounts ?? [],
        bankAccountNumberByTransactionId?.[selectedTx.id] ?? configuredBankAccountNumber,
        accounts === undefined,
      )
    : null;
  const targetTotal = totals?.target ?? 0;
  const splitDifference = totals?.difference ?? 0;
  const expectedBankType = selectedTx ? (selectedTx.amount >= 0 ? 'Soll' : 'Haben') : null;
  const expectedCounterType = expectedBankType === 'Soll' ? 'Haben' : expectedBankType === 'Haben' ? 'Soll' : null;
  const bankLines = draft && bankAccountNumber ? draft.lines.filter((line) => line.accountId === bankAccountNumber) : [];
  // Without the authoritative bank account we cannot identify a counterpart
  // line safely. Never treat every line as a counterpart based on a guess.
  const nonBankLines = draft && bankAccountNumber
    ? draft.lines.filter((line) => line.accountId !== bankAccountNumber)
    : [];
  const bankLine = bankLines[0];
  const bankLineAmount = bankLine ? amountValue(bankLine.amount) : NaN;
  const nonBankSameDirectionViolation = nonBankLines.some(
    (line) => expectedCounterType && line.accountId && line.type !== expectedCounterType,
  );
  const nonBankCounterTotal = nonBankLines.reduce((sum, line) => {
    const value = amountValue(line.amount);
    return expectedCounterType && line.type === expectedCounterType ? sum + value : sum;
  }, 0);
  const directionErrors: string[] = [];
  if (draft && expectedBankType) {
    if (bankLines.length !== 1) {
      directionErrors.push(`Es muss genau eine Bankzeile (${bankAccountNumber ?? 'Bankkonto'}) vorhanden sein.`);
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
  const splitIsValid = !draft || (totals?.bankLineCount === 1 && splitDifference < 0.01 && directionErrors.length === 0);

  const runPrimaryAction = async () => {
    if (!selectedTx || !primary || !splitIsValid) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await dispatchBookingAction(selectedTx.id, primary, { role, actorName: role });
      rememberConfirmation(selectedTx.id, primary);
      onRefresh();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Aktion konnte nicht gespeichert werden.');
    } finally {
      setMutationBusy(false);
    }
  };

  const isPosted = (transactionId: string) => {
    const status = getBookingDraftByTransactionId(transactionId)?.workflowStatus
      ?? transactions.find((tx) => tx.id === transactionId)?.workflowStatus;
    return status === 'posted' || status === 'reversed' || status === 'corrected';
  };

  const draftStatus = (transactionId: string) =>
    getBookingDraftByTransactionId(transactionId)?.workflowStatus ?? transactions.find((tx) => tx.id === transactionId)?.workflowStatus;

  // Undo sends a confirmation back while it still waits for approval; the reject carries the audit reason.
  // Approved drafts have no way back on the server, and posted ones only change through a Storno.
  const undoSessionMatch = async (transactionId: string) => {
    if (!sessionMatches[transactionId] || draftStatus(transactionId) !== 'pending_approval') return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      await dispatchBookingAction(transactionId, 'reject', { role, actorName: role, rejectReason: 'Bankabgleich: Bestätigung zurückgenommen' });
      setSessionMatches((prev) => {
        const next = { ...prev };
        delete next[transactionId];
        return next;
      });
      onRefresh();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Rückgängig machen fehlgeschlagen.');
    } finally {
      setMutationBusy(false);
    }
  };

  const selectedCandidates = selectedTx ? candidatesById[selectedTx.id] : undefined;
  const selectedZweifelsfall = selectedCandidates ? isZweifelsfall(selectedCandidates) : false;
  const sessionEntries = Object.entries(sessionMatches).flatMap(([id, match]) => {
    const tx = transactions.find((item) => item.id === id);
    return tx ? [{ tx, match }] : [];
  });
  const staleRules = (rules ?? []).filter((rule) => rule.active && daysSince(rule.lastHitAt ?? rule.createdAt) > RULE_STALE_DAYS);

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

  const saveInlineSplit = async () => {
    if (!draft) return;
    if (draftReadOnly) {
      setMutationError('POSTED_DRAFT_IMMUTABLE: Storno oder Korrektur erforderlich.');
      return;
    }
    setMutationBusy(true);
    setMutationError(null);
    try {
      await saveDraft(draft, role);
      onRefresh();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Split konnte nicht gespeichert werden.');
      setLocalDraft(storeDraft ?? null);
    } finally {
      setMutationBusy(false);
    }
  };

  return (
    <div className="flex">
      <div className="w-80 shrink-0 border-r border-border flex flex-col">
        <div className="sr-only">
          <div>
            <div>
              <ArrowRightLeft size={16} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2>Bankabgleich Workbench</h2>
              <p className="text-xs text-muted font-medium leading-tight">
                Vorschläge prüfen und in den Buchungsworkflow überführen.
              </p>
            </div>
          </div>
        </div>
        <section aria-label="Fortschritt Bankabgleich" className="border-b border-border px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-label font-semibold text-foreground">
              <span className="tabular-nums">{done}</span> von <span className="tabular-nums">{transactions.length}</span> Umsätzen erledigt
            </p>
            <span className="text-caption text-muted tabular-nums">{queue.length} offen</span>
          </div>
          <HatchedProgress className="mt-2" size="sm" value={transactions.length ? done / transactions.length : 0} label="Abgleichfortschritt" valueText={`${done} von ${transactions.length} erledigt`} />
          {confident.length > 0 && (
            <button
              type="button"
              onClick={() => setBatchOpen(true)}
              disabled={mutationBusy || !permissionCtx.canMutate}
              className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-control border border-control-border bg-surface text-xs font-semibold text-foreground hover:bg-surface-muted disabled:opacity-50"
            >
              <CheckCircle2 size={14} aria-hidden="true" />
              Sichere Treffer bestätigen ({confident.length})
            </button>
          )}
          {batchResult && (
            <p role="status" className="mt-2 text-caption text-muted">{batchResult}</p>
          )}
        </section>
        <ConfirmDialog
          open={batchOpen}
          title={`${confident.length} sichere Treffer bestätigen?`}
          description="Jeder Umsatz geht mit seinem Vorschlag den nächsten Workflow-Schritt, genau wie beim Einzelabgleich. Prüfungen und Freigaben bleiben erhalten."
          confirmLabel="Bestätigen"
          cancelLabel="Abbrechen"
          busy={mutationBusy}
          details={
            <ul className="space-y-1 text-sm text-foreground" aria-label="Betroffene Umsätze">
              {confident.map(({ tx, action }) => (
                <li key={tx.id} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">{tx.payee}</span>
                  <span className="shrink-0 text-muted">{actionLabel(action)} · <span className="tabular-nums">{formatCurrency(tx.amount, tx.currency)}</span></span>
                </li>
              ))}
            </ul>
          }
          onConfirm={() => void runConfidentBatch()}
          onCancel={() => setBatchOpen(false)}
        />
        <div className="overflow-y-auto p-3 space-y-2">
          {queue.map((tx) => {
            const status = getStatusPresentation(tx.workflowStatus);
            return (
              <button
                key={tx.id}
                onClick={() => setSelectedId(tx.id)}
                className={`w-full text-left border rounded-xl p-3 transition-colors ${
                  selectedTx?.id === tx.id
                    ? 'border-dark-base bg-surface-muted'
                    : 'border-border bg-surface hover:bg-surface-muted'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-sm text-foreground leading-tight">{tx.payee}</div>
                    <div className="text-xs text-muted mt-0.5 line-clamp-2">
                      {new Date(tx.date).toLocaleDateString('de-DE')} • {tx.description}
                    </div>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-xs font-semibold ${status.className}`}>
                    {status.label}
                  </span>
                </div>
                <div className={`text-xs font-semibold tabular-nums mt-1.5 ${tx.amount < 0 ? 'text-error-text' : 'text-success-text'}`}>
                  {formatCurrency(tx.amount, tx.currency)}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {candidatesById[tx.id] && isZweifelsfall(candidatesById[tx.id]) && <Badge tone="warning">Zweifelsfall</Badge>}
                  <IssueBadges transaction={tx} />
                </div>
              </button>
            );
          })}
          {queue.length === 0 && (
            <div className="border border-border rounded-xl p-6 text-sm text-muted bg-surface">
              Keine offenen Transaktionen im Abgleich.
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 p-6 overflow-y-auto max-h-[56vh]">
        {!selectedTx || !draft ? (
            <div className="text-muted">Keine Position ausgewählt.</div>
          ) : (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
            <section className="space-y-4">
              {mutationError && <div className="rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text" role="alert" aria-live="assertive">{mutationError}</div>}
              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="text-xs uppercase tracking-wider text-muted font-semibold">Bankbewegung</div>
                <div className="mt-2 grid grid-cols-1 2xl:grid-cols-2 gap-3 items-start">
                  <div className="min-w-0">
                    <div className="font-semibold text-base text-foreground">{selectedTx.payee}</div>
                    <div className="text-sm text-muted line-clamp-2">{selectedTx.description}</div>
                    <div className="text-xs text-muted mt-1">
                      {new Date(selectedTx.date).toLocaleDateString('de-DE')} • {selectedTx.id}
                    </div>
                  </div>
                  <div className={`text-xl font-semibold tabular-nums whitespace-nowrap ${selectedTx.amount < 0 ? 'text-error-text' : 'text-success-text'}`}>
                    {formatCurrency(selectedTx.amount, selectedTx.currency)}
                  </div>
                </div>
                <div className="mt-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">Gegenkonto</div>
                  <AccountCombobox
                    accounts={accountOptions}
                    valueAccountId={bankAccountNumber ? draft.lines.find((line) => line.accountId !== bankAccountNumber)?.accountId ?? '' : ''}
                    valueAccountName={bankAccountNumber ? draft.lines.find((line) => line.accountId !== bankAccountNumber)?.accountName ?? '' : ''}
                    disabled={draftReadOnly || !bankAccountNumber}
                    placeholder="Gegenkonto wählen..."
                    onSelect={(account) => {
                      if (!bankAccountNumber) return;
                      const line = draft.lines.find((item) => item.accountId !== bankAccountNumber);
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

              {canMatchInvoices && selectedTx.amount > 0 && (
                <section aria-label="Passende Rechnungen" className="border border-border rounded-2xl bg-surface p-5">
                  <div className="text-sm font-semibold text-foreground">Passende Rechnungen</div>
                  {!selectedCandidates ? (
                    <p className="mt-2 text-sm text-muted" role="status">Suche passende Rechnungen…</p>
                  ) : selectedCandidates.length === 0 ? (
                    <p className="mt-2 text-sm text-muted">Keine offene Rechnung passt zu diesem Umsatz.</p>
                  ) : (
                    <>
                      {selectedZweifelsfall && (
                        <div role="status" className="mt-3 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text">
                          <span className="font-semibold">Zweifelsfall: zwei Belege passen fast gleich gut.</span>{' '}
                          {selectedCandidates[0].invoiceNumber} und {selectedCandidates[1].invoiceNumber} liegen weniger als 10 Punkte auseinander. Es ist nichts vorausgewählt, bitte selbst zuordnen.
                        </div>
                      )}
                      <ul className="mt-3 space-y-2" aria-label="Kandidaten">
                        {selectedCandidates.map((candidate, index) => (
                          <li
                            key={candidate.invoiceId}
                            aria-label={`Rechnung ${candidate.invoiceNumber}`}
                            className={`rounded-xl border p-3 ${index === 0 && !selectedZweifelsfall && candidate.score >= CONFIDENT_THRESHOLD ? 'border-dark-base' : 'border-border'}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-foreground">{candidate.invoiceNumber}</div>
                                <div className="text-caption text-muted">
                                  {candidate.client}, fällig {new Date(candidate.dueDate).toLocaleDateString('de-DE')}
                                </div>
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="text-sm font-semibold tabular-nums text-foreground">{formatCurrency(candidate.amount, selectedTx.currency)}</div>
                                <Badge tone={candidate.score >= CONFIDENT_THRESHOLD ? 'success' : candidate.score > 0.5 ? 'warning' : 'neutral'}>
                                  <span className="tabular-nums">{Math.round(candidate.score * 100)} %</span>
                                </Badge>
                              </div>
                            </div>
                            <p className="mt-1.5 text-caption text-muted">{candidate.matchReasons.join(' · ')}</p>
                            {onOpenInvoice && (
                              <button
                                type="button"
                                onClick={() => onOpenInvoice(candidate.invoiceId)}
                                aria-label={`Rechnung ${candidate.invoiceNumber} in Offene Posten ausgleichen`}
                                className="mt-2 px-3 py-1.5 rounded-lg border border-control-border bg-surface text-xs font-semibold text-foreground hover:bg-surface-muted"
                              >
                                In Offene Posten ausgleichen
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}

              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-foreground">Kontierungsvorschlag</div>
                  <span className="text-xs text-muted font-medium">
                    Sicherheit {Math.round((selectedTx.suggestionConfidence ?? 0.5) * 100)} %
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  <div className="border border-border rounded-xl p-4 bg-surface-muted/50">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-foreground">
                        {selectedTx.suggestion ?? 'Kein Vorschlag'}
                      </div>
                    </div>
                    <div className="text-sm text-muted mt-2">
                      Entwurf enthält {draft.lines.length} Buchungszeilen und {draft.validationIssues.length} Validierungshinweise.
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          onClick={runPrimaryAction}
                          disabled={!primary || !splitIsValid || mutationBusy}
                        className="px-4 py-2 rounded-control bg-surface-inverse text-inverse-foreground text-sm font-semibold hover:bg-surface-inverse-raised disabled:opacity-40 inline-flex items-center gap-1"
                      >
                        <CheckCircle2 size={14} />
                        {primary ? 'Nächste Aktion' : 'Kein Schritt möglich'}
                      </button>
                        <button
                          onClick={() => onOpenTransaction(selectedTx.id)}
                        className="px-4 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted"
                      >
                        Im Editor öffnen
                      </button>
                        <button
                          className="px-4 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted inline-flex items-center gap-1"
                          onClick={addSplitLine}
                          disabled={draftReadOnly}
                      >
                        <GitBranch size={14} />
                        Split-Zeile hinzufügen
                      </button>
                    </div>
                  </div>
                  {!splitIsValid && (
                    <div className="mt-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                      <div className="font-semibold">Abgleich-Validierung fehlgeschlagen</div>
                      <ul className="mt-1 space-y-1">
                        {splitDifference >= 0.01 && (
                          <li>
                            Summe der Gegenbuchungen stimmt nicht mit der Bankbewegung überein. Differenz:{' '}
                            <span className="font-semibold tabular-nums">{formatCurrency(splitDifference, selectedTx.currency)}</span>
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
              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-foreground">Entwurf / Split-Bearbeitung inline</div>
                    <button
                    onClick={saveInlineSplit}
                    disabled={draftReadOnly || mutationBusy}
                    className="px-3 py-1.5 rounded-control bg-surface-inverse text-inverse-foreground text-xs font-semibold hover:bg-surface-inverse-raised"
                  >
                    Split speichern
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {draft.lines.map((line) => (
                    <div
                      key={line.id}
                      className="grid grid-cols-12 gap-2 items-center text-sm border border-border rounded-lg p-2"
                    >
                      <select
                        value={line.type}
                        onChange={(e) =>
                          updateLine(line.id, (cur) => ({ ...cur, type: e.target.value as 'Soll' | 'Haben' }))
                        }
                        disabled={draftReadOnly}
                        className="px-2.5 h-8 hover:border-control-border-hover col-span-2 border border-control-border rounded-control text-sm"
                        aria-label="Soll/Haben"
                      >
                        <option value="Soll">Soll</option>
                        <option value="Haben">Haben</option>
                      </select>
                      <div className="col-span-6">
                        <AccountCombobox
                          accounts={accountOptions}
                          valueAccountId={line.accountId}
                          valueAccountName={line.accountName}
                          disabled={draftReadOnly || !bankAccountNumber}
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
                        disabled={draftReadOnly}
                        className="px-2.5 h-8 hover:border-control-border-hover col-span-3 border border-control-border rounded-control text-sm text-right"
                        aria-label="Betrag"
                      />
                      <button
                        onClick={() => removeLine(line.id)}
                        className="col-span-1 text-xs font-semibold text-muted hover:text-error-text"
                        aria-label="Zeile entfernen"
                        disabled={draftReadOnly || draft.lines.length <= 2}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted">
                  <span className="tabular-nums">{draft.lines.length} Zeilen</span>
                  <span className="tabular-nums">Bank: {formatCurrency(totals?.bank ?? 0, selectedTx.currency)}</span>
                  <span className="tabular-nums">Gegenbuchungen: {formatCurrency(totals?.counterpart ?? 0, selectedTx.currency)}</span>
                  <span className="tabular-nums">Ziel: {formatCurrency(targetTotal, selectedTx.currency)}</span>
                  <span>
                    Richtung: {selectedTx.amount >= 0 ? 'Eingang (Bank Soll)' : 'Ausgang (Bank Haben)'}
                  </span>
                  <span className={`tabular-nums ${splitIsValid ? 'text-success-text font-semibold' : 'text-error-text font-semibold'}`}>
                    {splitIsValid ? 'OK' : `Diff ${formatCurrency(splitDifference, selectedTx.currency)}`}
                  </span>
                </div>
              </div>

              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="text-sm font-semibold text-foreground mb-2">Workflow Schnellaktionen</div>
                <div className="flex flex-wrap gap-2">
                  {allowed.map((action) => (
                    <button
                      key={action}
                      onClick={() => {
                        if (!splitIsValid && (action === 'submit_for_review' || action === 'approve' || action === 'post')) {
                          return;
                        }
                        void (async () => {
                          setMutationBusy(true);
                          setMutationError(null);
                          try {
                            await dispatchBookingAction(selectedTx.id, action, { role, actorName: role });
                            onRefresh();
                          } catch (error) {
                            setMutationError(error instanceof Error ? error.message : 'Aktion konnte nicht gespeichert werden.');
                          } finally {
                            setMutationBusy(false);
                          }
                        })();
                      }}
                      className="px-3 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted inline-flex items-center gap-1"
                      disabled={mutationBusy || (!splitIsValid && (action === 'submit_for_review' || action === 'approve' || action === 'post'))}
                    >
                      {action === 'post' ? <Play size={14} /> : <ArrowRight size={14} />}
                      {actionLabel(action)}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </div>
        )}

        {sessionEntries.length > 0 && (
          <section aria-label="Zugeordnet" className="mt-6 border border-border rounded-2xl bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">Zugeordnet</h3>
              <span className="text-caption text-muted">Rückweg bis zur Freigabe</span>
            </div>
            <ul>
              {sessionEntries.map(({ tx, match }) => {
                const posted = isPosted(tx.id);
                const undoable = draftStatus(tx.id) === 'pending_approval';
                return (
                  <li key={tx.id} className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-5 py-2.5 last:border-b-0">
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-semibold text-foreground">{tx.payee}</span>{' '}
                      <span className="text-muted">bestätigt: {match.label}</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-foreground">{formatCurrency(tx.amount, tx.currency)}</span>
                    {posted ? (
                      <Badge tone="success">gebucht</Badge>
                    ) : !undoable ? (
                      <Badge tone="neutral">freigegeben, wartet auf Buchung</Badge>
                    ) : (
                      <>
                        <Badge tone="warning">nicht gebucht</Badge>
                        <button
                          type="button"
                          onClick={() => void undoSessionMatch(tx.id)}
                          disabled={mutationBusy || !permissionCtx.canMutate}
                          aria-label={`Rückgängig: ${tx.payee}`}
                          className="px-3 py-1.5 rounded-lg border border-control-border bg-surface text-xs font-semibold text-foreground hover:bg-surface-muted disabled:opacity-50"
                        >
                          Rückgängig
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {dataAdapter?.listAccountSuggestionRules && (
          <section aria-label="Kontierungsregeln" className="mt-6 border border-border rounded-2xl bg-surface">
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">Regeln</h3>
              {rules && (staleRules.length > 0
                ? <Badge tone="warning">{staleRules.length} greifen nicht mehr</Badge>
                : <Badge tone="success">alle greifen</Badge>)}
              <span className="flex-1" />
              {onManageRules && (
                <button
                  type="button"
                  onClick={onManageRules}
                  className="px-3 py-1.5 rounded-lg border border-control-border bg-surface text-xs font-semibold text-foreground hover:bg-surface-muted"
                >
                  Regeln bearbeiten
                </button>
              )}
            </div>
            {rulesError ? (
              <p role="alert" className="px-5 py-3 text-sm text-error-text">{rulesError}</p>
            ) : !rules ? (
              <p className="px-5 py-3 text-sm text-muted" role="status">Regeln werden geladen…</p>
            ) : rules.length === 0 ? (
              <p className="px-5 py-3 text-sm text-muted">Noch keine Regeln angelegt.</p>
            ) : (
              <ul>
                {rules.map((rule) => {
                  const stale = staleRules.includes(rule);
                  const months = Math.max(1, Math.floor(daysSince(rule.lastHitAt ?? rule.createdAt) / 30.44));
                  return (
                    <li key={rule.id} aria-label={`Regel ${rule.value}`} className="flex flex-wrap items-start gap-3 border-b border-border-subtle px-5 py-2.5 last:border-b-0">
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="font-semibold text-foreground">
                          Wenn {RULE_FIELD_LABELS[rule.field]} {RULE_OPERATOR_LABELS[rule.operator]} „{rule.value}“
                        </span>
                        <span className="block text-caption text-muted">dann Konto {rule.targetAccountNumber}</span>
                        <span className="block text-caption text-muted tabular-nums">
                          {rule.hitCount
                            ? `${rule.hitCount} Treffer, zuletzt ${rule.lastHitAt ? new Date(rule.lastHitAt).toLocaleDateString('de-DE') : 'unbekannt'}`
                            : 'noch nie angewendet'}
                        </span>
                      </span>
                      {stale && <Badge tone="warning">seit {months === 1 ? 'einem Monat' : `${months} Monaten`} kein Treffer</Badge>}
                      {!rule.active && <Badge tone="neutral">deaktiviert</Badge>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
