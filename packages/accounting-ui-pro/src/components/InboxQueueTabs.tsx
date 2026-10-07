import { InboxQueueKey, inboxQueueLabels } from '../domain/selectors';

interface InboxQueueTabsProps {
  activeQueue: InboxQueueKey;
  counts: Record<InboxQueueKey, number>;
  onChange: (queue: InboxQueueKey) => void;
  queues?: InboxQueueKey[];
}

const MAIN_QUEUES: InboxQueueKey[] = ['all', 'incomplete', 'review', 'approval', 'posted', 'errors'];

/** Filter chips: a pill per queue with its count, the active one filled. */
export default function InboxQueueTabs({ activeQueue, counts, onChange, queues = MAIN_QUEUES }: InboxQueueTabsProps) {
  return (
    <div className="flex flex-wrap gap-1.25">
      {queues.map((queue) => (
        <button
          key={queue}
          type="button"
          onClick={() => onChange(queue)}
          aria-pressed={activeQueue === queue}
          className={`inline-flex items-center gap-1.25 whitespace-nowrap rounded-full border px-1.75 py-0.5 text-micro transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
            activeQueue === queue
              ? 'border-foreground bg-foreground font-semibold text-ground'
              : 'border-border bg-surface-sunken font-medium text-foreground-secondary hover:border-border-strong'
          }`}
        >
          {inboxQueueLabels[queue]} <span className="font-mono tabular-nums">{counts[queue] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
