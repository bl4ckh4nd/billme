import { useEffect, useMemo, useRef } from 'react';
import { Badge, Kbd, cn } from '@billme/ui';
import { Transaction } from '../types';
import { InboxQueueKey, getFlagLabel, getQueueCounts, inboxQueueLabels, txMatchesQueue } from '../domain/selectors';
import InboxQueueTabs from './InboxQueueTabs';
import { StatusBadge } from './IssueBadges';

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
    <nav aria-label="Warteschlange" className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">Warteschlange</h2>
        <InboxQueueTabs activeQueue={queue} counts={counts} onChange={onQueueChange} queues={QUEUES} />
        <p className="flex items-center gap-1 text-caption text-muted">
          <Kbd>j</Kbd> <Kbd>k</Kbd> wechselt den Vorgang
        </p>
      </div>
      {list.length === 0 ? (
        <p className="px-3 py-5 text-center text-control text-muted">Keine Vorgänge in „{inboxQueueLabels[queue]}“.</p>
      ) : (
        <ul ref={listRef} className="max-h-140 overflow-y-auto">
          {list.map((tx) => {
            const current = tx.id === selectedId;
            return (
              <li key={tx.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  onClick={() => onSelect(tx.id)}
                  aria-current={current ? 'true' : undefined}
                  className={cn(
                    'block w-full px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
                    current ? 'bg-accent-50 shadow-[inset_3px_0_0_var(--color-accent)]' : 'hover:bg-surface-muted',
                  )}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-label font-semibold text-foreground">{tx.payee}</span>
                    <span className={cn('shrink-0 font-mono text-label font-semibold tabular-nums', tx.amount < 0 ? 'text-foreground' : 'text-success-text')}>
                      {formatAmount(tx.amount, tx.currency)}
                    </span>
                  </span>
                  <span className="mt-0.75 flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-caption text-muted tabular-nums">{new Date(tx.date).toLocaleDateString('de-DE')}</span>
                    <StatusBadge status={tx.workflowStatus} />
                    {tx.flags.map((flag) => (
                      <Badge key={flag} tone="warning">{getFlagLabel(flag)}</Badge>
                    ))}
                  </span>
                  <span className="mt-0.75 block truncate text-caption text-muted">{tx.description}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
