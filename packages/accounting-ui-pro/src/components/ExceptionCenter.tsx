import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileSearch, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Textarea, cn, formatEmptyValue } from '@billme/ui';
import { getFlagLabel } from '../domain/selectors';
import { useAccountingWorkspace } from '../AccountingWorkspaceContext';
import { Transaction, UserRole } from '../types';
import { StatusBadge } from './IssueBadges';

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
  const store = useAccountingWorkspace();
  const { assignExceptionOwner, dispatchBookingAction, getBookingDraftByTransactionId, reopenException, resolveException, snoozeException } = store;
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

  const cardHead = 'border-b border-border px-3.5 py-3';

  return (
    <div>
      <div className="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Card padding="none" className="overflow-hidden">
          <div className={cardHead}>
            <div className="sr-only">
              <div>
                <AlertTriangle size={16} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2>Ausnahmen</h2>
                <p>Fehler, Warnungen und blockierte Buchungen.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.25">
              {(Object.keys(filterLabels) as ExceptionFilter[]).map((key) => (
                // Raw button: the filter chip of InboxQueueTabs; @billme/ui has no chip button.
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  aria-pressed={filter === key}
                  className={cn(
                    'inline-flex items-center whitespace-nowrap rounded-full border px-1.75 py-0.5 text-micro transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                    filter === key
                      ? 'border-foreground bg-foreground font-semibold text-ground'
                      : 'border-border bg-surface-sunken font-medium text-foreground-secondary hover:border-border-strong',
                  )}
                >
                  {filterLabels[key]}
                </button>
              ))}
            </div>
          </div>
          {items.length === 0 ? (
            <EmptyState title="Keine Einträge für den Filter." />
          ) : (
            <ul className="max-h-140 overflow-y-auto">
              {items.map((tx) => {
                const current = selectedTx?.id === tx.id;
                return (
                  <li key={tx.id} className="border-b border-border last:border-b-0">
                    {/* Raw button: a list row with three lines of content, not a labelled action. */}
                    <button
                      type="button"
                      onClick={() => setSelectedId(tx.id)}
                      aria-current={current ? 'true' : undefined}
                      className={cn(
                        'block w-full px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
                        current ? 'bg-accent-50 shadow-[inset_3px_0_0_var(--color-accent)]' : 'hover:bg-surface-muted',
                      )}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-label font-semibold text-foreground">{tx.payee}</span>
                        <StatusBadge status={tx.workflowStatus} />
                      </span>
                      <span className="mt-0.75 block truncate text-caption text-muted">{tx.description}</span>
                      <span className="mt-0.75 flex flex-wrap gap-1.5">
                        {tx.issueCounts.errors > 0 && <Badge tone="error">{tx.issueCounts.errors} Fehler</Badge>}
                        {tx.issueCounts.warnings > 0 && (
                          <Badge tone="warning">{tx.issueCounts.warnings} {tx.issueCounts.warnings === 1 ? 'Warnung' : 'Warnungen'}</Badge>
                        )}
                        {tx.flags.map((flag) => (
                          <Badge key={flag} tone="neutral">{getFlagLabel(flag)}</Badge>
                        ))}
                        {tx.exceptionCase?.state && (
                          <Badge tone={tx.exceptionCase.state === 'resolved' ? 'success' : tx.exceptionCase.state === 'snoozed' ? 'info' : 'neutral'}>
                            {exceptionStateLabels[tx.exceptionCase.state]}
                          </Badge>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-3.5">
          {!selectedTx || !selectedDraft ? (
            <Card padding="none">
              <EmptyState title="Keine Ausnahme ausgewählt." />
            </Card>
          ) : (
            <>
              <Card padding="none">
                <div className={cn('flex flex-wrap items-start gap-x-3 gap-y-2', cardHead)}>
                  <div className="min-w-0 flex-1">
                    <div className="text-eyebrow uppercase text-muted">Vorgang</div>
                    <h3 className="text-section text-foreground">{selectedTx.payee}</h3>
                    <p className="text-caption text-muted">{selectedTx.description}</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => onOpenTransaction(selectedTx.id)}>
                    Im Editor öffnen
                  </Button>
                </div>
                <div className="flex flex-col gap-2.5 p-3.5">
                  <div className="text-label text-foreground">Validierungsdetails</div>
                  {selectedDraft.validationIssues.length === 0 && !hasActiveExceptionMarkers ? (
                    <div className="text-control text-success-text">Keine aktiven Validierungsprobleme.</div>
                  ) : selectedDraft.validationIssues.length === 0 ? (
                    <div className="rounded-control border border-warning-border bg-warning-bg px-3 py-2.5 text-control text-warning-text" role="status">
                      Aktive Hinweise: {exceptionMarkers.join(', ')}
                    </div>
                  ) : (
                    <ul className="flex flex-col gap-2.5">
                      {selectedDraft.validationIssues.map((issue) => (
                        <li key={issue.id}>
                          <Card padding="sm">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge tone={issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'neutral'}>
                                {issue.severity === 'error' ? 'Fehler' : issue.severity === 'warning' ? 'Warnung' : 'Hinweis'}
                              </Badge>
                              {issue.blocking && <Badge tone="error">Blocker</Badge>}
                            </div>
                            <div className="mt-1.5 text-label text-foreground">{issue.message}</div>
                            {/* Code und Feldpfad sind technische Details für den Support, nicht die Überschrift. */}
                            <div className="mt-1 text-caption text-muted">
                              Code {issue.code}{issue.fieldPath ? ` · Feld ${issue.fieldPath}` : ''}
                            </div>
                          </Card>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card padding="none">
                <CardHeader as="h3" title="Schnellmaßnahmen" className={cardHead} />
                <div className="flex flex-wrap gap-2 p-3.5">
                  <Button variant="secondary" size="sm" onClick={() => onOpenTransaction(selectedTx.id)}>
                    <FileSearch size={14} aria-hidden="true" /> Prüfen
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void (async () => {
                      setMutationError(null);
                      try {
                        await dispatchBookingAction(selectedTx.id, 'request_receipt', { role, actorName: role });
                        onRefresh();
                      } catch (error) {
                        setMutationError(error instanceof Error ? error.message : 'Aktion konnte nicht gespeichert werden.');
                      }
                    })()}
                  >
                    Beleg anfordern
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => onRefresh()}>
                    <RefreshCw size={14} aria-hidden="true" /> Neu bewerten
                  </Button>
                </div>
              </Card>

              <Card padding="none">
                <CardHeader as="h3" title="Ausnahme bearbeiten" className={cardHead} />
                <div className="flex flex-col gap-3 p-3.5">
                  {!canMutateExceptions && <div className="text-control text-muted" role="status">Änderungen an Ausnahmen sind in dieser Oberfläche nicht verfügbar.</div>}
                  {mutationError && (
                    <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">{mutationError}</div>
                  )}
                  <fieldset disabled={!canMutateExceptions} className="flex min-w-0 flex-col gap-3">
                    <div className="flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <Input
                          fullWidth
                          type="text"
                          label="Verantwortliche Person"
                          value={ownerDraft}
                          onChange={(e) => setOwnerDraft(e.target.value)}
                          placeholder="Name"
                        />
                      </div>
                      <Button variant="secondary" onClick={() => void (async () => {
                        setMutationError(null);
                        try {
                          await assignExceptionOwner(selectedTx.id, ownerDraft || role, role);
                          onRefresh();
                        } catch (error) {
                          setMutationError(error instanceof Error ? error.message : 'Änderung konnte nicht gespeichert werden.');
                        }
                      })()}>
                        Zuweisen
                      </Button>
                    </div>

                    <div className="flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <Input
                          fullWidth
                          type="date"
                          label="Pausiert bis"
                          value={snoozeUntil}
                          onChange={(e) => setSnoozeUntil(e.target.value)}
                        />
                      </div>
                      <Button
                        variant="secondary"
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
                      >
                        Pausieren
                      </Button>
                    </div>

                    <Textarea
                      fullWidth
                      label="Lösungsnotiz"
                      value={resolutionNote}
                      onChange={(e) => setResolutionNote(e.target.value)}
                      placeholder="Was wurde geprüft/gelöst?"
                    />

                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => void (async () => {
                        setMutationError(null);
                        try {
                          await resolveException(selectedTx.id, resolutionNote || 'Manuell als gelöst markiert', role);
                          onRefresh();
                        } catch (error) {
                          setMutationError(error instanceof Error ? error.message : 'Änderung konnte nicht gespeichert werden.');
                        }
                      })()}>
                        Als gelöst markieren
                      </Button>
                      <Button variant="secondary" onClick={() => void (async () => {
                        setMutationError(null);
                        try {
                          await reopenException(selectedTx.id, role);
                          onRefresh();
                        } catch (error) {
                          setMutationError(error instanceof Error ? error.message : 'Änderung konnte nicht gespeichert werden.');
                        }
                      })()}>
                        Wieder öffnen
                      </Button>
                    </div>
                  </fieldset>
                </div>
              </Card>

              <Card padding="none">
                <CardHeader as="h3" title="Workflow-Status" className={cardHead} />
                <div className="flex flex-col gap-2 p-3.5 text-control">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Status</span>
                    <StatusBadge status={selectedTx.workflowStatus} />
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Fehler</span>
                    <span className="font-semibold tabular-nums text-error-text">{selectedTx.issueCounts.errors}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Warnungen</span>
                    <span className="font-semibold tabular-nums text-warning-text">{selectedTx.issueCounts.warnings}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Freigabe</span>
                    <span className="font-medium text-foreground">{selectedDraft.approval.status}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Ausnahmestatus</span>
                    <span className="font-medium text-foreground">{exceptionState === 'snoozed' ? 'Pausiert' : exceptionState === 'resolved' ? 'Erledigt' : 'Offen'}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Verantwortliche Person</span>
                    <span className="font-medium text-foreground">{formatEmptyValue(selectedTx.exceptionCase?.owner)}</span>
                  </div>
                  {selectedTx.exceptionCase?.snoozedUntil && (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted">Pausiert bis</span>
                      <span className="font-medium text-foreground">{selectedTx.exceptionCase.snoozedUntil}</span>
                    </div>
                  )}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
