import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileSearch, RefreshCw } from 'lucide-react';
import { getStatusPresentation } from '../domain/selectors';
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
  transactions: Transaction[];
  onOpenTransaction: (transactionId: string) => void;
  onRefresh: () => void;
}

const filterLabels: Record<ExceptionFilter, string> = {
  all: 'Alle',
  open: 'Offen',
  snoozed: 'Snoozed',
  resolved: 'Erledigt',
  errors: 'Fehler',
  warnings: 'Warnungen',
  missing_receipt: 'Ohne Beleg',
  duplicates: 'Dubletten',
  period_locked: 'Periode gesperrt',
};

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

export default function ExceptionCenter({ role, transactions, onOpenTransaction, onRefresh }: ExceptionCenterProps) {
  const [filter, setFilter] = useState<ExceptionFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ownerDraft, setOwnerDraft] = useState('Mara Buchhaltung');
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');

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

  return (
    <div className="flex h-full">
      <div className="w-[26rem] shrink-0 border-r border-border-subtle flex flex-col">
        <div className="px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-foreground text-accent-lime flex items-center justify-center shrink-0">
              <AlertTriangle size={15} />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-black tracking-tight text-foreground leading-tight">Exception Center</h1>
              <p className="text-xs text-muted font-medium leading-tight">Fehler, Warnungen und blockierte Buchungen.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {(Object.keys(filterLabels) as ExceptionFilter[]).map((key) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`h-7 px-2.5 rounded-full text-xs font-bold border ${
                  filter === key ? 'bg-foreground text-white border-foreground' : 'bg-surface text-muted border-border'
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
                selectedTx?.id === tx.id ? 'border-foreground bg-surface-muted' : 'border-border bg-surface hover:bg-surface-muted'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-bold text-foreground truncate">{tx.payee}</div>
                <span className={`px-2 py-1 rounded-full text-[11px] font-bold ${getStatusPresentation(tx.workflowStatus).className}`}>
                  {getStatusPresentation(tx.workflowStatus).label}
                </span>
              </div>
              <div className="text-xs text-muted mt-1 truncate">{tx.description}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {tx.issueCounts.errors > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-error-bg text-error">
                    {tx.issueCounts.errors} Fehler
                  </span>
                )}
                {tx.issueCounts.warnings > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-warning-bg text-warning">
                    {tx.issueCounts.warnings} Warnungen
                  </span>
                )}
                {tx.flags.map((flag) => (
                  <span key={flag} className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-canvas text-muted">
                    {flag}
                  </span>
                ))}
                {tx.exceptionCase?.state && (
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                    tx.exceptionCase.state === 'resolved'
                      ? 'bg-success-bg text-success'
                      : tx.exceptionCase.state === 'snoozed'
                        ? 'bg-info-bg text-info'
                        : 'bg-canvas text-muted'
                  }`}>
                    {tx.exceptionCase.state}
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

      <div className="flex-1 min-w-0 p-6 overflow-auto">
        {!selectedTx || !selectedDraft ? (
          <div className="text-muted">Keine Exception ausgewählt.</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_1fr] gap-6">
            <div className="space-y-4">
              <div className="border border-border rounded-xl bg-surface p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted font-bold">Case</div>
                    <div className="font-bold text-lg text-foreground mt-1">{selectedTx.payee}</div>
                    <div className="text-sm text-muted">{selectedTx.description}</div>
                  </div>
                  <button
                    onClick={() => onOpenTransaction(selectedTx.id)}
                    className="px-4 py-2 rounded-full bg-foreground text-white text-sm font-bold hover:bg-foreground"
                  >
                    Im Editor öffnen
                  </button>
                </div>
              </div>

              <div className="border border-border rounded-xl bg-surface p-5">
                <div className="text-sm font-bold text-foreground mb-2">Validierungsdetails</div>
                {selectedDraft.validationIssues.length === 0 ? (
                  <div className="text-sm text-success">Keine aktiven Validierungsprobleme.</div>
                ) : (
                  <ul className="space-y-2">
                    {selectedDraft.validationIssues.map((issue) => (
                      <li key={issue.id} className="border border-border-subtle rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${
                              issue.severity === 'error'
                                ? 'bg-error-bg'
                                : issue.severity === 'warning'
                                  ? 'bg-warning-bg0'
                                  : 'bg-border'
                            }`}
                          />
                          <span className="text-sm font-bold text-foreground">{issue.code}</span>
                          {issue.blocking && (
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-error-bg text-error">
                              Blocker
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-muted mt-1">{issue.message}</div>
                        {issue.fieldPath && <div className="text-xs text-muted mt-1">Feld: {issue.fieldPath}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="border border-border rounded-xl bg-surface p-5">
                <div className="text-sm font-bold text-foreground mb-3">Schnellmaßnahmen</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => onOpenTransaction(selectedTx.id)}
                    className="px-4 py-2 rounded-full border border-border bg-surface text-sm font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1"
                  >
                    <FileSearch size={14} /> Prüfen
                  </button>
                  <button
                    onClick={() => {
                      try {
                        dispatchBookingAction(selectedTx.id, 'request_receipt', { role, actorName: role });
                        onRefresh();
                      } catch {
                        onOpenTransaction(selectedTx.id);
                      }
                    }}
                    className="px-4 py-2 rounded-full border border-border bg-surface text-sm font-bold text-muted hover:bg-surface-muted"
                  >
                    Beleg anfordern
                  </button>
                  <button
                    onClick={() => onRefresh()}
                    className="px-4 py-2 rounded-full border border-border bg-surface text-sm font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1"
                  >
                    <RefreshCw size={14} /> Neu bewerten
                  </button>
                </div>
              </div>

              <div className="border border-border rounded-xl bg-surface p-5">
                <div className="text-sm font-bold text-foreground mb-3">Exception Resolution Flow</div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
                      Owner zuweisen
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={ownerDraft}
                        onChange={(e) => setOwnerDraft(e.target.value)}
                        className="flex-1 border border-border rounded-lg px-3 py-2 text-sm"
                        placeholder="Owner"
                      />
                      <button
                        onClick={() => {
                          assignExceptionOwner(selectedTx.id, ownerDraft || role, role);
                          onRefresh();
                        }}
                        className="px-3 py-2 rounded-xl border border-border text-sm font-bold text-muted hover:bg-surface-muted"
                      >
                        Zuweisen
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
                      Snooze bis
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="date"
                        value={snoozeUntil}
                        onChange={(e) => setSnoozeUntil(e.target.value)}
                        className="flex-1 border border-border rounded-lg px-3 py-2 text-sm"
                      />
                      <button
                        onClick={() => {
                          if (!snoozeUntil) return;
                          snoozeException(selectedTx.id, snoozeUntil, role, resolutionNote || 'Snoozed aus Exception Center');
                          onRefresh();
                        }}
                        className="px-3 py-2 rounded-xl border border-border text-sm font-bold text-muted hover:bg-surface-muted"
                      >
                        Snooze
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
                      Lösungsnotiz
                    </label>
                    <textarea
                      value={resolutionNote}
                      onChange={(e) => setResolutionNote(e.target.value)}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm min-h-20"
                      placeholder="Was wurde geprüft/gelöst?"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        resolveException(selectedTx.id, resolutionNote || 'Manuell als gelöst markiert', role);
                        onRefresh();
                      }}
                      className="px-4 py-2 rounded-full bg-foreground text-white text-sm font-bold hover:bg-foreground"
                    >
                      Als gelöst markieren
                    </button>
                    <button
                      onClick={() => {
                        reopenException(selectedTx.id, role);
                        onRefresh();
                      }}
                      className="px-4 py-2 rounded-full border border-border bg-surface text-sm font-bold text-muted hover:bg-surface-muted"
                    >
                      Reopen
                    </button>
                  </div>
                </div>
              </div>

              <div className="border border-border rounded-xl bg-surface p-5">
                <div className="text-sm font-bold text-foreground mb-2">Workflow Snapshot</div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted">Status</span>
                    <span className="font-bold text-foreground">{getStatusPresentation(selectedTx.workflowStatus).label}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Fehler</span>
                    <span className="font-bold text-error">{selectedTx.issueCounts.errors}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Warnungen</span>
                    <span className="font-bold text-warning">{selectedTx.issueCounts.warnings}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Freigabe</span>
                    <span className="font-bold text-foreground">{selectedDraft.approval.status}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Exception Status</span>
                    <span className="font-bold text-foreground">{exceptionState}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Owner</span>
                    <span className="font-bold text-foreground">{selectedTx.exceptionCase?.owner ?? '—'}</span>
                  </div>
                  {selectedTx.exceptionCase?.snoozedUntil && (
                    <div className="flex justify-between">
                      <span className="text-muted">Snoozed bis</span>
                      <span className="font-bold text-foreground">{selectedTx.exceptionCase.snoozedUntil}</span>
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
