/**
 * An org's own usage this month.
 *
 * Same four verbs `usage-benchmark.ts` sweeps every org for — that script
 * exists to calibrate Core's included allowances against Andrew's pilot
 * month; this is the same counting logic scoped down to one org and the
 * current month, for a carrier to see their own instead. See that script's
 * module note for why these four and not others: `document.received` over
 * its downstream echoes (`document.extracted`/`validated`) so an upload
 * isn't counted twice, `broker.verified` filtered to `actorType: 'user'`
 * so the nightly re-check sweep doesn't count against anyone, and Routes
 * excluded entirely because `feasibility.ts` writes no event to count.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { actorTypeEnum } from '../schema/enums.ts';
import { eventLog } from '../schema/events.ts';

export interface MonthlyUsage {
  monthStart: Date;
  documentsReceived: number;
  invoicesGenerated: number;
  trackCheckins: number;
  brokerChecks: number;
}

function startOfMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function countVerb(
  s: Scope,
  verb: string,
  monthStart: Date,
  actorType?: (typeof actorTypeEnum.enumValues)[number],
): Promise<number> {
  const [row] = await s.db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventLog)
    .where(
      and(
        eq(eventLog.orgId, s.ctx.orgId),
        eq(eventLog.verb, verb),
        gte(eventLog.occurredAt, monthStart),
        ...(actorType ? [eq(eventLog.actorType, actorType)] : []),
      ),
    );
  return row?.count ?? 0;
}

/** This org's counts for the calendar month containing `now()`, UTC. */
export async function monthlyUsage(s: Scope): Promise<MonthlyUsage> {
  const monthStart = startOfMonthUtc();
  const [documentsReceived, invoicesGenerated, trackCheckins, brokerChecks] = await Promise.all([
    countVerb(s, 'document.received', monthStart),
    countVerb(s, 'invoice.generated', monthStart),
    countVerb(s, 'load_stop.checkin', monthStart),
    countVerb(s, 'broker.verified', monthStart, 'user'),
  ]);
  return { monthStart, documentsReceived, invoicesGenerated, trackCheckins, brokerChecks };
}
