/**
 * Billing-relevant usage, read from `event_log`.
 *
 * Exists so a script or route can ask "how many of X did org Y do this
 * month" without reaching for `drizzle-orm`'s operators itself — those stay
 * inside `packages/db`, same convention every repository here already
 * follows. `usage-benchmark.ts` is the current caller, built ahead of
 * Andrew's (the pilot carrier) trial to set the Carrier Core plan's included
 * allowances against his real usage rather than a guess.
 *
 * See that script's own module note for which verbs count as usage and
 * which (Insights' reads, the nightly re-check sweep) deliberately don't,
 * and for the gap on HaulQ Routes — feasibility checks are not event-logged
 * at all yet.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.ts';
import type { Actor } from '../context.ts';
import { eventLog } from '../schema/events.ts';
import type { EventVerb } from './catalog.ts';

/** Matches `actor_type`'s pgEnum values in `schema/enums.ts`. */
type ActorType = Actor['type'];

export interface OrgMonthCount {
  orgId: string;
  /** First of the month, UTC, as `YYYY-MM-01`. */
  month: string;
  count: number;
}

/**
 * Every org's monthly count of one verb, across all of `event_log` history.
 *
 * `actorType` narrows to who did it — e.g. `broker.verified` filtered to
 * `'user'` counts only checks a carrier asked for, not the nightly re-check
 * sweep's own `'system'` rows. Omit it to count every actor.
 */
export async function countEventsByOrgMonth(
  db: Database,
  verb: EventVerb,
  actorType?: ActorType,
): Promise<OrgMonthCount[]> {
  const conditions = [eq(eventLog.verb, verb)];
  if (actorType) conditions.push(eq(eventLog.actorType, actorType));

  const rows = await db
    .select({
      orgId: eventLog.orgId,
      month: sql<string>`to_char(date_trunc('month', ${eventLog.occurredAt}), 'YYYY-MM-01')`.as('month'),
      count: sql<number>`count(*)::int`.as('count'),
    })
    .from(eventLog)
    .where(and(...conditions))
    .groupBy(eventLog.orgId, sql`date_trunc('month', ${eventLog.occurredAt})`);

  return rows;
}
