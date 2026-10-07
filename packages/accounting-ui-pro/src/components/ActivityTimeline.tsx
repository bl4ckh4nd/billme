import { Timeline } from '@billme/ui';
import { ActivityEvent } from '../types';

interface ActivityTimelineProps {
  events: ActivityEvent[];
}

export default function ActivityTimeline({ events }: ActivityTimelineProps) {
  return (
    <section>
      <h3 className="mb-2 text-eyebrow uppercase text-muted">Aktivität</h3>
      {events.length === 0 ? (
        <p className="text-caption text-muted">Noch keine Aktivität.</p>
      ) : (
        <Timeline
          label="Aktivität"
          entries={events.map((event) => ({
            key: event.id,
            title: event.label,
            meta: (
              <>
                {event.details && <span className="block">{event.details}</span>}
                {new Date(event.at).toLocaleString('de-DE')} • {event.actorName}
              </>
            ),
            tone: event.type === 'booking_posted' ? 'success' : event.type === 'booking_reversed' ? 'warning' : 'neutral',
          }))}
        />
      )}
    </section>
  );
}
