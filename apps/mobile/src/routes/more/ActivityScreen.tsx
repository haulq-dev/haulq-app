/**
 * Activity: everything that has happened on the account, in plain language.
 * Web's `Timeline.tsx` on a phone (MOBILE_PARITY_PLAN.md M5).
 *
 * Renders the API's `explanation` and nothing else. Building prose from
 * `verb` here is how a log ends up saying different things in different
 * places (guardrail 6). Grouped by day, because a phone scrolls a long list
 * and a date header is what tells you where you are in it.
 *
 * Who did it is always shown, and anything HaulQ did says HaulQ: an agent's
 * action must never look like a person's (guardrail 5).
 */

import { activityDay, actorLabel, useTimeline, type TimelineEntry } from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { Empty, ErrorNote, LoadMore, Pill } from '../../components/ui.tsx';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function ActivityScreen() {
  const timeline = useTimeline();
  const items = timeline.data?.pages.flatMap((p) => p.items) ?? [];

  const groups: { day: string; entries: TimelineEntry[] }[] = [];
  for (const entry of items) {
    const day = activityDay(entry.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ More
      </Link>
      <h1 className="text-2xl">Activity</h1>
      <p className="text-sm text-slate">This record can't be edited or deleted. Corrections are added to the end.</p>

      {timeline.isError && <ErrorNote error={timeline.error} />}
      {timeline.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {timeline.isSuccess && items.length === 0 && (
        <div className="hq-card px-4">
          <Empty>Nothing has happened yet.</Empty>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.day} className="space-y-1.5">
          <h2 className="field-label px-1">{g.day}</h2>
          <ol className="hq-card divide-y divide-line px-4">
            {g.entries.map((e) => (
              <li key={e.seq} className="py-3">
                {/* `break-words`: explanations carry email addresses and ids with nowhere to wrap. */}
                <p className="break-words text-sm">{e.explanation}</p>
                <p className="mt-1 flex items-center gap-2 text-xs text-mute">
                  <span className="num">{time(e.occurredAt)}</span>
                  {e.actorType === 'agent' ? <Pill tone="warn">HaulQ</Pill> : <span>{actorLabel(e.actorType)}</span>}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ))}

      <LoadMore onClick={() => void timeline.fetchNextPage()} loading={timeline.isFetchingNextPage} hasMore={timeline.hasNextPage} />
    </div>
  );
}
