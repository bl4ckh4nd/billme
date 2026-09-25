import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@billme/ui';
import { Transaction } from '../types';
import { InboxQueueKey, getFlagLabel, getQueueCounts, getStatusPresentation, inboxQueueLabels, txMatchesQueue } from '../domain/selectors';

const QUEUES: InboxQueueKey[] = ['all', 'incomplete', 'review', 'approval', 'posted', 'errors', 'missing_receipt'];

const formatAmount = (amount: number, currency: string) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(amount);

interface WorkbenchQueueProps {
  transactions: Transaction[];
  queue: InboxQueueKey;
  onQueueChange: (queue: InboxQueueKey) => void;
  selectedId: string | null;
  onSelect: (transactionId: string) => void;
}

/**
 * Left pane of the booking workbench: the current queue stays in view while a
 * transaction is edited, so the next one is one click (or `j`/`k`) away.
 */
export default function WorkbenchQueue({ transactions, queue, onQueueChange, selectedId, onSelect }: WorkbenchQueueProps) {
  const counts = useMemo(() => getQueueCounts(transactions), [transactions]);
  const list = useMemo(() => transactions.filter((tx) => txMatchesQueue(tx, queue)), [transactions, queue]);
  const listRef = useRef<HTMLUListElement | null>(null);

  // j / k move through the queue unless the user is typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'j' && event.key !== 'k') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (list.length === 0) return;
      const index = list.findIndex((tx) => tx.id === selectedId);
      const next = list[Math.max(0, Math.min(list.length - 1, index + (event.key === 'j' ? 1 : -1)))];
      if (next && next.id !== selectedId) {
        event.preventDefault();
        onSelect(next.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [list, onSelect, selectedId]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <nav aria-label="Warteschlange" className="flex h-full min-h-0 flex-col border-r border-border bg-surface">
      <div className="shrink-0 border-b border-border p-3">
        <label htmlFor="workbench-queue" className="mb-1 block text-caption font-medium text-muted">Warteschlange</label>
        <select
          id="workbench-queue"
          value={queue}
          onChange={(event) => onQueueChange(event.target.value as InboxQueueKey)}
          className="h-8 w-full rounded-control border border-control-border bg-surface px-2 text-label text-foreground focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          {QUEUES.map((key) => (
            <option key={key} value={key}>
              {inboxQueueLabels[key]} ({counts[key] ?? 0})
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-caption text-muted">
          <kbd className="font-mono">j</kbd> / <kbd className="font-mono">k</kbd> wechselt den Vorgang
        </p>
      </div>
      {list.length === 0 ? (
        <p className="p-4 text-caption text-muted">Keine Vorgänge in „{inboxQueueLabels[queue]}“.</p>
      ) : (
        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          {list.map((tx) => {
            const status = getStatusPresentation(tx.workflowStatus);
            const current = tx.id === selectedId;
            return (
              <li key={tx.id}>
                <button
                  type="button"
                  onClick={() => onSelect(tx.id)}
                  aria-current={current ? 'true' : undefined}
                  className={cn(
                    'block w-full border-b border-border px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
                    current ? 'bg-accent-50 shadow-[inset_3px_0_0_var(--color-accent)]' : 'hover:bg-surface-muted',
                  )}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-label font-semibold text-foreground">{tx.payee}</span>
                    <span className={cn('shrink-0 text-label font-semibold tabular-nums', tx.amount < 0 ? 'text-foreground' : 'text-success-text')}>
                      {formatAmount(tx.amount, tx.currency)}
                    </span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-caption text-muted tabular-nums">{new Date(tx.date).toLocaleDateString('de-DE')}</span>
                    <span className={cn('rounded-full px-1.5 py-px text-[0.6875rem] font-semibold', status.className)}>{status.label}</span>
                    {tx.flags.map((flag) => (
                      <span key={flag} className="rounded-full border border-warning-border bg-warning-bg px-1.5 py-px text-[0.6875rem] font-medium text-warning-text">
                        {getFlagLabel(flag)}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
