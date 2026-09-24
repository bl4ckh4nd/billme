import { InboxQueueKey, inboxQueueLabels } from '../domain/selectors';

interface InboxQueueTabsProps {
  activeQueue: InboxQueueKey;
  counts: Record<InboxQueueKey, number>;
  onChange: (queue: InboxQueueKey) => void;
}

export default function InboxQueueTabs({ activeQueue, counts, onChange }: InboxQueueTabsProps) {
  const mainQueues: InboxQueueKey[] = ['all', 'incomplete', 'review', 'approval', 'posted', 'errors'];

  return (
    <div className="flex flex-wrap gap-1.5">
      {mainQueues.map((queue) => (
        <button
          key={queue}
          onClick={() => onChange(queue)}
          className={`h-7 px-3 rounded-lg text-xs font-semibold border transition-colors ${
            activeQueue === queue
              ? 'bg-surface-inverse text-inverse-foreground border-surface-inverse'
              : 'bg-surface text-muted border-border hover:bg-surface-muted'
          }`}
        >
          {inboxQueueLabels[queue]} <span className="tabular-nums">{counts[queue] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

