import { formatAbsoluteDate, formatRelativeDate } from '../lib/format.js';

export interface TimelineEvent {
  id: string;
  title: string;
  description?: string;
  timestamp: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger' | 'info';
}

const dotClasses = {
  default: 'bg-muted',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-accent',
};

interface TimelineProps {
  events: TimelineEvent[];
  emptyLabel?: string;
}

export function Timeline({ events, emptyLabel = 'Sin eventos recientes' }: TimelineProps) {
  if (events.length === 0) {
    return <p className="text-sm text-muted">{emptyLabel}</p>;
  }

  return (
    <ol className="space-y-4">
      {events.map((event) => (
        <li key={event.id} className="relative pl-6">
          <span
            className={`absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ${dotClasses[event.tone ?? 'default']}`}
          />
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-medium text-ink">{event.title}</div>
            <time
              className="text-xs text-muted"
              dateTime={event.timestamp}
              title={formatAbsoluteDate(event.timestamp)}
            >
              {formatRelativeDate(event.timestamp)}
            </time>
          </div>
          {event.description ? <p className="mt-1 text-sm text-muted">{event.description}</p> : null}
        </li>
      ))}
    </ol>
  );
}
