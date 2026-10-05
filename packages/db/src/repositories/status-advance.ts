/**
 * Moving a load along from what its driver reported.
 *
 * A driver's check-ins already say what happened: departing the first pickup
 * means the freight is moving, departing the last delivery means it has been
 * delivered. Without this, a dispatcher has to restate both by hand, and
 * everything downstream of `delivered` — invoicing, Autopilot's
 * delivered-to-paid loop — waits on someone remembering a dropdown.
 *
 * **A sweep, not part of the check-in write.** A driver can undo a check-in
 * for `CHECKIN_UNDO_WINDOW_MS`, and the status trigger forbids moving a load
 * backwards. Advancing inside `applyStopCheckin` would let a mis-tapped
 * "Departed" make a load delivered for good, with the undo clearing the stop
 * but not the status. Advancing only once a departure is older than the undo
 * window means the status never moves on a report that can still be taken
 * back, so nothing ever needs reversing.
 *
 * **Forward only, and only from a booked load.** A prospect or quote with a
 * check-in on it is a data problem, not a delivery, so it is left for a
 * person. A load a dispatcher has already moved at or past the target is
 * left alone, and so is a load with no truck: `loads_dispatched_has_truck`
 * refuses every status from dispatched on without one, a dispatcher's
 * manual move included, so assigning the truck comes first either way.
 * Carriers without an active subscription are skipped, the same as the
 * detention scan: nobody there can get past the paywall to see the change.
 * The move itself is `updateLoadStatus`, so it stamps the same
 * timestamps (`deliveredAt` is the departure time, not the sweep's) and
 * records the same events as a manual one; the actor is
 * `system`/`checkin-status`, so the timeline shows HaulQ made it.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { canTransition, type LoadStatus } from '@haulq/contracts';
import type { Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { loads, loadStops } from '../schema/loads.ts';
import { orgs } from '../schema/tenancy.ts';
import { withTransaction } from '../transaction.ts';
import { getLoad, updateLoadStatus } from './loads.ts';
import { CHECKIN_UNDO_WINDOW_MS } from './track.ts';

/** Statuses a check-in can move a load out of. */
const ADVANCEABLE: readonly LoadStatus[] = ['booked', 'dispatched', 'in_transit'];

export interface StatusAdvanceCandidate {
  orgId: string;
  loadId: string;
  reference: number;
  from: LoadStatus;
  to: 'in_transit' | 'delivered';
  /** The departure that decided it. Becomes the status timestamp. */
  at: Date;
}

/**
 * Which move, if any, a load's stops call for. Pure, so the rules are
 * testable without a database: last stop is a delivery and departed →
 * delivered; otherwise the first pickup departed → in transit (only from
 * booked or dispatched). A departure younger than the undo window counts as
 * not departed yet.
 */
export function statusAdvanceFor(
  status: LoadStatus,
  stops: readonly { seq: number; type: 'pickup' | 'delivery'; departedAt: Date | null }[],
  now: Date,
): { to: 'in_transit' | 'delivered'; at: Date } | null {
  if (!ADVANCEABLE.includes(status) || stops.length === 0) return null;

  const settled = (d: Date | null): d is Date => d !== null && now.getTime() - d.getTime() >= CHECKIN_UNDO_WINDOW_MS;
  const ordered = [...stops].sort((a, b) => a.seq - b.seq);

  const last = ordered[ordered.length - 1]!;
  if (last.type === 'delivery' && settled(last.departedAt)) {
    return { to: 'delivered', at: last.departedAt };
  }

  const firstPickup = ordered.find((stop) => stop.type === 'pickup');
  if (status !== 'in_transit' && firstPickup && settled(firstPickup.departedAt)) {
    return { to: 'in_transit', at: firstPickup.departedAt };
  }

  return null;
}

/** Mirrors `loads_dispatched_has_truck`: past booked, a load needs a truck unless it is imported history. */
const canHoldDispatchedStatus = (load: { truckId: string | null; source: string }) =>
  load.truckId !== null || load.source === 'csv_import';

/** Every load, across every org, that its check-ins say should move on. */
export async function findStatusAdvanceCandidates(
  db: Database,
  now: Date = new Date(),
): Promise<StatusAdvanceCandidate[]> {
  const open = await db
    .select({
      orgId: loads.orgId,
      loadId: loads.id,
      reference: loads.reference,
      status: loads.status,
      truckId: loads.truckId,
      source: loads.source,
    })
    .from(loads)
    .innerJoin(orgs, eq(orgs.id, loads.orgId))
    .where(and(eq(orgs.status, 'active'), inArray(loads.status, [...ADVANCEABLE]), isNull(loads.deletedAt)));
  if (open.length === 0) return [];

  const stops = await db
    .select({ loadId: loadStops.loadId, seq: loadStops.seq, type: loadStops.type, departedAt: loadStops.departedAt })
    .from(loadStops)
    .where(inArray(loadStops.loadId, open.map((l) => l.loadId)))
    .orderBy(asc(loadStops.seq));

  const byLoad = new Map<string, typeof stops>();
  for (const stop of stops) {
    const list = byLoad.get(stop.loadId) ?? [];
    list.push(stop);
    byLoad.set(stop.loadId, list);
  }

  const candidates: StatusAdvanceCandidate[] = [];
  for (const load of open) {
    if (!canHoldDispatchedStatus(load)) continue;
    const move = statusAdvanceFor(load.status, byLoad.get(load.loadId) ?? [], now);
    if (move) candidates.push({ orgId: load.orgId, loadId: load.loadId, reference: load.reference, from: load.status, ...move });
  }
  return candidates;
}

/**
 * Makes one candidate's move, if it still applies. Re-reads the load inside
 * the transaction: between the sweep's read and this write a dispatcher may
 * have moved it themselves, and moving it again — or backwards — would be
 * wrong. Returns whether it moved.
 */
export async function advanceLoadStatus(db: Database, candidate: StatusAdvanceCandidate): Promise<boolean> {
  const s: Scope = {
    ctx: {
      orgId: candidate.orgId,
      actor: { type: 'system', name: 'checkin-status' },
      correlationId: randomUUID(),
    },
    db,
  };

  return withTransaction(s, async (tx) => {
    const current = await getLoad(tx, candidate.loadId);
    if (!current || !ADVANCEABLE.includes(current.status) || !canHoldDispatchedStatus(current)) return false;
    if (current.status === candidate.to || !canTransition(current.status, candidate.to).allowed) return false;

    await updateLoadStatus(tx, candidate.loadId, { status: candidate.to, occurredAt: candidate.at.toISOString() });
    return true;
  });
}
