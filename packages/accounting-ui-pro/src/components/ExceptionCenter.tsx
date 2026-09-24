import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileSearch, RefreshCw } from 'lucide-react';
import { formatEmptyValue } from '@billme/ui';
import { getFlagLabel, getStatusPresentation } from '../domain/selectors';
import {
  assignExceptionOwner,
  dispatchBookingAction,
  getBookingDraftByTransactionId,
  reopenException,
  resolveException,
  snoozeException,
} from '../services/mockBookingStore';
import { Transaction, UserRole } from '../types';

type ExceptionFilter = 'all' | 'open' | 'snoozed' | 'resolved' | 'errors' | 'warnings' | 'missing_receipt' | 'duplicates' | 'period_locked';

interface ExceptionCenterProps {
  role: UserRole;
  canMutateExceptions?: boolean;
  transactions: Transaction[];
  onOpenTransaction: (transactionId: string) => void;
  onRefresh: () => void;
}

const filterLabels: Record<ExceptionFilter, string> = {
  all: 'Alle',
  open: 'Offen',
  snoozed: 'Pausiert',
  resolved: 'Erledigt',
  errors: 'Fehler',
  warnings: 'Warnungen',
  missing_receipt: 'Ohne Beleg',
  duplicates: 'Dubletten',
  period_locked: 'Periode gesperrt',
};

const exceptionStateLabels = {
  open: 'Offen',
  snoozed: 'Pausiert',
  resolved: 'Erledigt',
} as const;

function matchesFilter(tx: Transaction, filter: ExceptionFilter) {
  switch (filter) {
    case 'all':
      return tx.issueCounts.errors > 0 || tx.issueCounts.warnings > 0 || tx.flags.length > 0;
    case 'errors':
      return tx.issueCounts.errors > 0;
    case 'open':
      return (tx.exceptionCase?.state ?? 'open') === 'open';
    case 'snoozed':
      return tx.exceptionCase?.state === 'snoozed';
    case 'resolved':
      return tx.exceptionCase?.state === 'resolved';
    case 'warnings':
      return tx.issueCounts.warnings > 0;
    case 'missing_receipt':
      return tx.flags.includes('missing_receipt');
    case 'duplicates':
      return tx.flags.includes('duplicate_suspected');
    case 'period_locked':
      return tx.flags.includes('period_locked') || tx.workflowStatus === 'period_locked';
    default:
      return false;
  }
}

export default function ExceptionCenter({ role, canMutateExceptions = true, transactions, onOpenTransaction, onRefresh }: ExceptionCenterProps) {
  const [filter, setFilter] = useState<ExceptionFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ownerDraft, setOwnerDraft] = useState('Mara Buchhaltung');
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);

  const items = useMemo(() => transactions.filter((tx) => matchesFilter(tx, filter)), [transactions, filter]);
  const selectedTx = items.find((tx) => tx.id === selectedId) ?? items[0] ?? null;
  const selectedDraft = selectedTx ? getBookingDraftByTransactionId(selectedTx.id) : undefined;
  const exceptionState = selectedTx?.exceptionCase?.state ?? 'open';

  useEffect(() => {
    if (!selectedTx) return;
    setOwnerDraft(selectedTx.exceptionCase?.owner ?? selectedTx.owner ?? 'Mara Buchhaltung');
    setSnoozeUntil(selectedTx.exceptionCase?.snoozedUntil ?? '');
    setResolutionNote(selectedTx.exceptionCase?.resolutionNote ?? '');
  }, [selectedTx?.id]);

  const hasActiveExceptionMarkers =
    selectedTx != null && (selectedTx.issueCounts.errors > 0 || selectedTx.issueCounts.warnings > 0 || selectedTx.flags.length > 0);
  const exceptionMarkers = selectedTx
    ? [
        ...selectedTx.flags.map(getFlagLabel),
        selectedTx.issueCounts.errors > 0 ? `${selectedTx.issueCounts.errors} Fehler` : null,
        selectedTx.issueCounts.warnings > 0 ? `${selectedTx.issueCounts.warnings} ${selectedTx.issueCounts.warnings === 1 ? 'Warnung' : 'Warnungen'}` : null,
      ].filter((marker): marker is string => Boolean(marker))
    : [];

  return (
    <div className="flex h-full min-w-0 flex-col lg:flex-row">
      <div className="flex w-full max-h-80 shrink-0 flex-col border-b border-subtle lg:max-h-none lg:w-96 lg:border-b-0 lg:border-r">
        <div className="px-4 py-3 border-b border-subtle">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-control bg-surface-sunken text-foreground flex items-center justify-center shrink-0">
              <AlertTriangle size={16} />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-tight text-foreground leading-tight">Ausnahmen</h1>
              <p className="text-xs text-muted font-medium leading-tight">Fehler, Warnungen und blockierte Buchungen.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {(Object.keys(filterLabels) as ExceptionFilter[]).map((key) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`h-7 px-2.5 rounded-lg text-xs font-semibold border ${
                  filter === key ? 'bg-surface-inverse text-inverse-foreground border-surface-inverse' : 'bg-surface text-muted border-border'
                }`}
              >
                {filterLabels[key]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {items.map((tx) => (
            <button
              key={tx.id}
              onClick={() => setSelectedId(tx.id)}
              className={`w-full text-left border rounded-xl p-4 ${
                selectedTx?.id === tx.id ? 'border-dark-base bg-surface-muted' : 'border-border bg-surface hover:bg-surface-muted'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-foreground truncate">{tx.payee}</div>
                <span className={`px-2 py-1 rounded-full text-xs font-semibold ${getStatusPresentation(tx.workflowStatus).className}`}>
                  {getStatusPresentation(tx.workflowStatus).label}
                </span>
              </div>
              <div className="text-xs text-muted mt-1 truncate">{tx.description}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {tx.issueCounts.errors > 0 && (
                  <span className="px-2 py-0.5 rounded-full border border-error-text bg-error-bg text-error-text text-xs font-semibold">
                    {tx.issueCounts.errors} Fehler
                  </span>
                )}
                {tx.issueCounts.warnings > 0 && (
                  <span className="px-2 py-0.5 rounded-full border border-warning-text bg-warning-bg text-warning-text text-xs font-semibold">
                    {tx.issueCounts.warnings} {tx.issueCounts.warnings === 1 ? 'Warnung' : 'Warnungen'}
                  </span>
                )}
                {tx.flags.map((flag) => (
                  <span key={flag} className="px-2 py-0.5 rounded-full border border-border bg-border-subtle text-foreground text-xs font-semibold">
                    {getFlagLabel(flag)}
                  </span>
                ))}
                {tx.exceptionCase?.state && (
                  <span className={`px-2 py-0.5 rounded-full border text-xs font-semibold ${
                    tx.exceptionCase.state === 'resolved'
                      ? 'border-success-text bg-success-bg text-success-text'
                      : tx.exceptionCase.state === 'snoozed'
                        ? 'border-info-text bg-info-bg text-info-text'
                        : 'border-border bg-border-subtle text-foreground'
                  }`}>
                    {exceptionStateLabels[tx.exceptionCase.state]}
                  </span>
                )}
              </div>
            </button>
          ))}
          {items.length === 0 && (
            <div className="border border-border rounded-xl p-6 text-sm text-muted bg-surface">
              Keine Einträge für den Filter.
            </div>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-auto p-6">
        {!selectedTx || !selectedDraft ? (
          <div className="text-muted">Keine Ausnahme ausgewählt.</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted font-semibold">Vorgang</div>
                    <div className="font-semibold text-lg text-foreground mt-1">{selectedTx.payee}</div>
                    <div className="text-sm text-muted">{selectedTx.description}</div>
                  </div>
                  <button
                    onClick={() => onOpenTransaction(selectedTx.id)}
                    className="shrink-0 whitespace-nowrap px-4 py-2 rounded-control bg-surface-inverse text-inverse-foreground text-sm font-semibold hover:bg-surface-inverse-raised"
                  >
                    Im Editor öffnen
                  </button>
                </div>
              </div>

              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="text-sm font-semibold text-foreground mb-2">Validierungsdetails</div>
                {selectedDraft.validationIssues.length === 0 && !hasActiveExceptionMarkers ? (
                  <div className="text-sm text-success-text">Keine aktiven Validierungsprobleme.</div>
                ) : selectedDraft.validationIssues.length === 0 ? (
                  <div className="text-sm text-warning-text" role="status">
                    Aktive Hinweise: {exceptionMarkers.join(', ')}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {selectedDraft.validationIssues.map((issue) => (
                      <li key={issue.id} className="border border-subtle rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={`inline-block h-2 w-2 rounded-full ${
                              issue.severity === 'error'
                                ? 'bg-error'
                                : issue.severity === 'warning'
                                  ? 'bg-warning'
                                  : 'bg-muted'
                            }`}
                          />
                          <span className={`text-xs font-semibold ${
                            issue.severity === 'error'
                              ? 'text-error-text'
                              : issue.severity === 'warning'
                                ? 'text-warning-text'
                                : 'text-muted'
                          }`}>
                            {issue.severity === 'error' ? 'Fehler' : issue.severity === 'warning' ? 'Warnung' : 'Hinweis'}
                          </span>
                          {issue.blocking && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-error-bg text-error-text">
                              Blocker
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-medium text-foreground mt-1">{issue.message}</div>
                        {/* Code und Feldpfad sind technische Details für den Support, nicht die Überschrift. */}
                        <div className="text-caption text-muted mt-1">
                          Code {issue.code}{issue.fieldPath ? ` · Feld ${issue.fieldPath}` : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="text-sm font-semibold text-foreground mb-3">Schnellmaßnahmen</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => onOpenTransaction(selectedTx.id)}
                    className="px-4 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted inline-flex items-center gap-1"
                  >
                    <FileSearch size={14} /> Prüfen
                  </button>
                  <button
                    onClick={() => {
                      void (async () => {
                        setMutationError(null);
                        try {
                          await dispatchBookingAction(selectedTx.id, 'request_receipt', { role, actorName: role });
                          onRefresh();
                        } catch (error) {
                          setMutationError(error instanceof Error ? error.message : 'Aktion konnte nicht gespeichert werden.');
                        }
                      })();
                    }}
                    className="px-4 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted"
                  >
                    Beleg anfordern
                  </button>
                  <button
                    onClick={() => onRefresh()}
                    className="px-4 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted inline-flex items-center gap-1"
                  >
                    <RefreshCw size={14} /> Neu bewerten
                  </button>
                </div>
              </div>

              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="text-sm font-semibold text-foreground mb-3">Ausnahme bearbeiten</div>
                {!canMutateExceptions && <div className="mb-3 text-sm text-muted" role="status">Änderungen an Ausnahmen sind in dieser Oberfläche nicht verfügbar.</div>}
                {mutationError && <div className="mb-3 text-sm text-error-text" role="alert" aria-live="assertive">{mutationError}</div>}
                <fieldset disabled={!canMutateExceptions} className="space-y-3">
                <div className="space-y-3">
                  <div>
                    <label className="block mb-1 text-label text-foreground">
                      Verantwortliche Person
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={ownerDraft}
                        onChange={(e) => setOwnerDraft(e.target.value)}
                        className="px-2.5 h-8 hover:border-ink-500 flex-1 border border-control-border rounded-control text-sm"
                        placeholder="Name"
                      />
                      <button
                        onClick={() => void (async () => {
                          setMutationError(null);
                          try {
                            await assignExceptionOwner(selectedTx.id, ownerDraft || role, role);
                            onRefresh();
                          } catch (error) {
                            setMutationError(error instanceof Error ? error.message : 'Änderung konnte nicht gespeichert werden.');
                          }
                        })()}
                        className="px-3 py-2 rounded-xl border border-border text-sm font-semibold text-foreground hover:bg-surface-muted"
                      >
                        Zuweisen
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block mb-1 text-label text-foreground">
                      Pausiert bis
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="date"
                        value={snoozeUntil}
                        onChange={(e) => setSnoozeUntil(e.target.value)}
                        className="px-2.5 h-8 hover:border-ink-500 flex-1 border border-control-border rounded-control text-sm"
                      />
                      <button
                        onClick={() => void (async () => {
                          if (!snoozeUntil) return;
                          setMutationError(null);
                          try {
                            await snoozeException(selectedTx.id, snoozeUntil, role, resolutionNote || 'Pausiert aus dem Ausnahmebereich');
                            onRefresh();
                          } catch (error) {
                            setMutationError(error instanceof Error ? error.message : 'Änderung konnte nicht gespeichert werden.');
                          }
                        })()}
                        className="px-3 py-2 rounded-xl border border-border text-sm font-semibold text-foreground hover:bg-surface-muted"
                      >
                      Pausieren
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block mb-1 text-label text-foreground">
                      Lösungsnotiz
                    </label>
                    <textarea
                      value={resolutionNote}
                      onChange={(e) => setResolutionNote(e.target.value)}
                      className="px-2.5 py-2 hover:border-ink-500 w-full border border-control-border rounded-control text-sm min-h-20"
                      placeholder="Was wurde geprüft/gelöst?"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void (async () => {
                        setMutationError(null);
                        try {
                          await resolveException(selectedTx.id, resolutionNote || 'Manuell als gelöst markiert', role);
                          onRefresh();
                        } catch (error) {
                          setMutationError(error instanceof Error ? error.message : 'Änderung konnte nicht gespeichert werden.');
                        }
                      })()}
                      className="px-4 py-2 rounded-control bg-surface-inverse text-inverse-foreground text-sm font-semibold hover:bg-surface-inverse-raised"
                    >
                      Als gelöst markieren
                    </button>
                    <button
                      onClick={() => void (async () => {
                        setMutationError(null);
                        try {
                          await reopenException(selectedTx.id, role);
                          onRefresh();
                        } catch (error) {
                          setMutationError(error instanceof Error ? error.message : 'Änderung konnte nicht gespeichert werden.');
                        }
                      })()}
                      className="px-4 py-2 rounded-lg border border-control-border bg-surface text-sm font-semibold text-foreground hover:bg-surface-muted"
                    >
                      Wieder öffnen
                    </button>
                  </div>
                </div>
                </fieldset>
              </div>

              <div className="border border-border rounded-2xl bg-surface p-5">
                <div className="text-sm font-semibold text-foreground mb-2">Workflow-Status</div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted">Status</span>
                    <span className="font-semibold text-foreground">{getStatusPresentation(selectedTx.workflowStatus).label}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Fehler</span>
                    <span className="font-semibold tabular-nums text-error-text">{selectedTx.issueCounts.errors}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Warnungen</span>
                    <span className="font-semibold tabular-nums text-warning-text">{selectedTx.issueCounts.warnings}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Freigabe</span>
                    <span className="font-semibold text-foreground">{selectedDraft.approval.status}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Ausnahmestatus</span>
                    <span className="font-semibold text-foreground">{exceptionState === 'snoozed' ? 'Pausiert' : exceptionState === 'resolved' ? 'Erledigt' : 'Offen'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Verantwortliche Person</span>
                    <span className="font-semibold text-foreground">{formatEmptyValue(selectedTx.exceptionCase?.owner)}</span>
                  </div>
                  {selectedTx.exceptionCase?.snoozedUntil && (
                    <div className="flex justify-between">
                      <span className="text-muted">Pausiert bis</span>
                      <span className="font-semibold text-foreground">{selectedTx.exceptionCase.snoozedUntil}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
