import { ActivityEvent } from '../types';

interface ActivityTimelineProps {
  events: ActivityEvent[];
}

export default function ActivityTimeline({ events }: ActivityTimelineProps) {
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-surface-muted border-b border-border text-sm font-bold text-foreground">
        Aktivität
      </div>
      <div className="max-h-64 overflow-auto divide-y divide-border-subtle">
        {events.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted">Noch keine Aktivität.</div>
        ) : (
          events.map((event) => (
            <div key={event.id} className="px-4 py-3">
              <div className="text-sm font-bold text-foreground">{event.label}</div>
              {event.details && <div className="text-xs text-muted mt-0.5">{event.details}</div>}
              <div className="text-xs text-muted mt-1">
                {new Date(event.at).toLocaleString('de-DE')} • {event.actorName}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

