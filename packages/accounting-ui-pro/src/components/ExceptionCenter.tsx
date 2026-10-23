import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, FileSearch, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Textarea, cn, formatEmptyValue } from '@billme/ui';
import { getFlagLabel } from '../domain/selectors';
import { useAccountingWorkspace } from '../AccountingWorkspaceContext';
import { Transaction, UserRole } from '../types';
import type { ProAccountingDataAdapter, TransitOverview } from '../services/accountingDataAdapter';
import { permissionContextForRole } from '../domain/permissions';
import { StatusBadge } from './IssueBadges';

type ExceptionFilter = 'all' | 'open' | 'snoozed' | 'resolved' | 'errors' | 'warnings' | 'missing_receipt' | 'duplicates' | 'period_locked' | 'transit';

interface ExceptionCenterProps {
  role: UserRole;
  canMutateExceptions?: boolean;
  transactions: Transaction[];
  onOpenTransaction: (transactionId: string) => void;
  onRefresh: () => void;
  dataAdapter?: ProAccountingDataAdapter;
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
  transit: 'Geldtransit offen',
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

export default function ExceptionCenter({ role, canMutateExceptions = true, transactions, onOpenTransaction, onRefresh, dataAdapter }: ExceptionCenterProps) {
  const store = useAccountingWorkspace();
  const { assignExceptionOwner, dispatchBookingAction, getBookingDraftByTransactionId, reopenException, resolveException, snoozeException } = store;
  const [filter, setFilter] = useState<ExceptionFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ownerDraft, setOwnerDraft] = useState('Mara Buchhaltung');
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [transit, setTransit] = useState<TransitOverview | null>(null);
  const loadTransit = () => {
    void dataAdapter?.getTransitOverview?.().then(setTransit).catch(() => setTransit(null));
  };
  useEffect(loadTransit, [dataAdapter, transactions]);
  const filters = (Object.keys(filterLabels) as ExceptionFilter[]).filter((key) => key !== 'transit' || Boolean(dataAdapter?.getTransitOverview));
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
              {filters.map((key) => (
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
                  {key === 'transit' && transit && transit.openSides.length > 0 && <span className="ml-1.25 font-mono tabular-nums">{transit.openSides.length}</span>}
                </button>
              ))}
            </div>
          </div>
          {filter === 'transit' ? (
            <TransitSides overview={transit} selectedId={selectedId} onSelect={setSelectedId} />
          ) : items.length === 0 ? (
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
          {filter === 'transit' ? (
            <TransitDetail
              overview={transit}
              selectedId={selectedId}
              canMutate={permissionContextForRole(role).canMutate && Boolean(dataAdapter?.confirmTransfer)}
              onOpenTransaction={onOpenTransaction}
              onAssign={async (transactionId, partnerTransactionId) => {
                await dataAdapter!.confirmTransfer!({ transactionId, partnerTransactionId, post: true });
                loadTransit();
                onRefresh();
              }}
            />
          ) : !selectedTx || !selectedDraft ? (
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

type OpenSide = TransitOverview['openSides'][number];

const money = (amount: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
const monthLabel = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleDateString('de-DE', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Posted Geldtransit sides whose partner is not posted yet. */
function TransitSides({ overview, selectedId, onSelect }: { overview: TransitOverview | null; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!overview || overview.openSides.length === 0) {
    return <EmptyState title="Geldtransit ist ausgeglichen." description="Jede gebuchte Umbuchung hat ihre Gegenseite." />;
  }
  const current = overview.openSides.find((side) => side.transactionId === selectedId) ?? overview.openSides[0];
  return (
    <ul className="max-h-140 overflow-y-auto">
      {overview.openSides.map((side) => (
        <li key={side.transactionId} className="border-b border-border last:border-b-0">
          <button
            type="button"
            onClick={() => onSelect(side.transactionId)}
            aria-current={current?.transactionId === side.transactionId ? 'true' : undefined}
            className={cn(
              'block w-full px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
              current?.transactionId === side.transactionId ? 'bg-accent-50 shadow-[inset_3px_0_0_var(--color-accent)]' : 'hover:bg-surface-muted',
            )}
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-label font-semibold text-foreground">{side.counterparty || side.purpose}</span>
              <span className="font-mono text-label tabular-nums text-foreground">{money(side.amount)}</span>
            </span>
            <span className="mt-0.75 block truncate text-caption text-muted">
              {side.accountName} · {new Date(side.date).toLocaleDateString('de-DE')} · Buchung {side.entryNumber}
            </span>
            <span className="mt-0.75 flex flex-wrap gap-1.5">
              <Badge tone="accent"><ArrowRightLeft size={12} aria-hidden="true" /> {side.partnerAccountName ? `Gegenseite ${side.partnerAccountName}` : 'Gegenkonto offen'}</Badge>
              {side.partnerTransactionId ? <Badge tone="info">Gegenseite nicht gebucht</Badge> : <Badge tone="warning">Partner gesucht</Badge>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Geldtransit balance per month plus the candidates for the selected open side. */
function TransitDetail({ overview, selectedId, canMutate, onOpenTransaction, onAssign }: {
  overview: TransitOverview | null;
  selectedId: string | null;
  canMutate: boolean;
  onOpenTransaction: (transactionId: string) => void;
  onAssign: (transactionId: string, partnerTransactionId: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!overview) return <Card padding="none"><EmptyState title="Geldtransit wird geladen." /></Card>;
  const side: OpenSide | undefined = overview.openSides.find((entry) => entry.transactionId === selectedId) ?? overview.openSides[0];
  const assign = async (partnerTransactionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await onAssign(side!.transactionId, partnerTransactionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Zuordnung konnte nicht gespeichert werden.');
    } finally {
      setBusy(false);
    }
  };
  const cardHead = 'border-b border-border px-3.5 py-3';
  return (
    <>
      <Card padding="none">
        <CardHeader as="h3" title={`Saldo Geldtransit ${overview.transitAccountNumber} je Monat`} className={cardHead} />
        {overview.months.length === 0 ? (
          <div className="p-3.5 text-control text-muted">Noch keine Buchung auf Geldtransit.</div>
        ) : (
          <table className="w-full text-control">
            <thead>
              <tr className="text-caption text-muted">
                <th scope="col" className="px-3.5 py-1.5 text-left font-medium">Monat</th>
                <th scope="col" className="px-3.5 py-1.5 text-right font-medium">Soll</th>
                <th scope="col" className="px-3.5 py-1.5 text-right font-medium">Haben</th>
                <th scope="col" className="px-3.5 py-1.5 text-right font-medium">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {overview.months.map((month) => (
                <tr key={month.period} className="border-t border-border">
                  <td className="px-3.5 py-1.5 text-foreground">{monthLabel(month.period)}</td>
                  <td className="px-3.5 py-1.5 text-right font-mono tabular-nums">{money(month.debit)}</td>
                  <td className="px-3.5 py-1.5 text-right font-mono tabular-nums">{money(month.credit)}</td>
                  <td className={cn('px-3.5 py-1.5 text-right font-mono font-semibold tabular-nums', month.balance === 0 ? 'text-success-text' : 'text-warning-text')}>
                    {month.balance === 0 ? 'ausgeglichen' : money(month.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="border-t border-border px-3.5 py-2 text-caption text-muted">
          Offen insgesamt: <span className="font-mono font-semibold tabular-nums text-foreground">{money(overview.openBalance)}</span>. Ein Saldo bleibt, solange eine Seite ohne Gegenseite gebucht ist.
        </div>
      </Card>

      {side && (
        <Card padding="none">
          <div className={cn('flex flex-wrap items-start gap-x-3 gap-y-2', cardHead)}>
            <div className="min-w-0 flex-1">
              <div className="text-eyebrow uppercase text-muted">Offene Seite</div>
              <h3 className="text-section text-foreground">{side.counterparty || side.purpose}</h3>
              <p className="text-caption text-muted">{side.accountName} · {new Date(side.date).toLocaleDateString('de-DE')} · {money(side.amount)}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => onOpenTransaction(side.transactionId)}>Im Editor öffnen</Button>
          </div>
          <div className="flex flex-col gap-2.5 p-3.5">
            {error && <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert">{error}</div>}
            {side.partnerTransactionId ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-control">
                <span className="text-foreground">Die Gegenseite ist zugeordnet, aber noch nicht gebucht.</span>
                <Button size="sm" onClick={() => onOpenTransaction(side.partnerTransactionId!)}>Gegenseite öffnen</Button>
              </div>
            ) : (
              <>
                <div className="text-label text-foreground">Partner gesucht</div>
                {side.candidates.length === 0 ? (
                  <div className="text-control text-muted">Kein Umsatz mit Gegenbetrag auf einem anderen eigenen Konto. Importieren Sie die Umsätze von {side.partnerAccountName ?? 'dem anderen Konto'}.</div>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {side.candidates.map((candidate) => (
                      <li key={candidate.transactionId} className="flex flex-wrap items-center gap-2 rounded-control border border-border px-2.75 py-2">
                        <div className="min-w-0 flex-1 basis-56">
                          <div className="truncate text-label text-foreground">{candidate.counterparty || candidate.purpose}</div>
                          <div className="text-caption text-muted">
                            {candidate.accountName} · {new Date(candidate.date).toLocaleDateString('de-DE')} · {Math.abs(candidate.days)} {Math.abs(candidate.days) === 1 ? 'Tag' : 'Tage'} {candidate.days >= 0 ? 'später' : 'früher'}
                          </div>
                        </div>
                        {candidate.outsideWindow && <Badge tone="warning">außerhalb des Zeitfensters</Badge>}
                        <span className="font-mono text-label tabular-nums text-foreground">{money(candidate.amount)}</span>
                        <Button size="sm" onClick={() => void assign(candidate.transactionId)} disabled={busy || !canMutate}>
                          Als Gegenseite zuordnen
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-caption text-muted">Zuordnen bucht die Gegenseite sofort über Geldtransit.</p>
              </>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
