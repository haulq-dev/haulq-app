/**
 * The audit trail.
 *
 * Renders `explanation` and nothing else. The API composes that sentence from
 * the event catalogue, and this screen deliberately does not build prose from
 * `verb` and `data` — that is exactly how a log ends up saying different things
 * in different places, which is the failure guardrail 6 exists to prevent.
 *
 * `actorType` is shown because the distinction is the point: an action HaulQ
 * took should be visibly different from one a person took.
 */

import { useQuery } from '@tanstack/react-query';
import { request, type TimelineEntry } from '../lib/api.ts';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';

const ACTOR_LABEL: Record<string, string> = {
  user: 'you',
  agent: 'HaulQ',
  system: 'HaulQ',
  integration: 'a connected service',
};

function when(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function TimelineScreen() {
  const timeline = useQuery({
    queryKey: ['timeline'],
    queryFn: () => request<{ items: TimelineEntry[] }>('/v1/timeline?limit=100'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl">Activity</h1>
        <p className="mt-1 max-w-prose text-slate">
          Everything that has happened on this account, in plain language. This
          record cannot be edited or deleted — corrections are added to the end.
        </p>
      </div>

      <Card>
        {timeline.isError && <ErrorNote error={timeline.error} />}
        {timeline.data?.items.length === 0 && <Empty>Nothing has happened yet.</Empty>}

        <ol className="divide-y divide-line">
          {timeline.data?.items.map((entry) => (
            <li key={entry.seq} className="flex items-baseline gap-4 py-3 first:pt-0">
              <span className="num w-20 shrink-0 text-xs text-mute">
                {when(entry.occurredAt)}
              </span>
              <span className="flex-1 text-sm">{entry.explanation}</span>
              {/* Agent actions are called out. A model's action must never be
                  indistinguishable from a person's — guardrail 5. */}
              {entry.actorType === 'agent' ? (
                <Pill tone="warn">HaulQ · {entry.actorId}</Pill>
              ) : (
                <span className="field-label shrink-0 text-mute">
                  {ACTOR_LABEL[entry.actorType] ?? entry.actorType}
                </span>
              )}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
