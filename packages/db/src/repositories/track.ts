/**
 * Track — Phase 2a.
 *
 * PHASE_2_PLAN.md section 4's exit gate, split into what this file owns:
 * issuing and validating the two token-linked routes (a driver's check-in,
 * a broker's read-only tracking page) and writing what they report — a
 * stop's detention-evidence timestamps, and a truck's position.
 *
 * Both link kinds reuse the token-hash shape `repositories/members.ts`
 * already established for invitations: a random token, only its sha256
 * stored, looked up by hash rather than scanned. The one thing this file
 * adds is a third actor shape neither invitations nor webhooks needed — a
 * driver holding a check-in link is not a HaulQ user (no Clerk account,
 * `drivers.userId` stays null, see `schema/fleet.ts`'s header) and not a
 * cron job either. `recordStopCheckin` and `recordCheckinPosition` write as
 * `{ type: 'integration', provider: 'driver_checkin_link' }`, the same
 * family `postmark-inbound.ts` already uses for an external actor that
 * authenticates by possessing a secret rather than by signing in.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { eventLog } from '../schema/events.ts';
import { recordEvent } from '../events/record.ts';
import { estimatedArrival } from '../geo.ts';
import { brokers } from '../schema/brokers.ts';
import { drivers, trucks } from '../schema/fleet.ts';
import { loads, loadStops } from '../schema/loads.ts';
import { orgs } from '../schema/tenancy.ts';
import { loadCheckinLinks, loadVisibilityLinks, truckPositions } from '../schema/track.ts';
import { withTransaction } from '../transaction.ts';

export type StopMilestone = 'arrived' | 'loading_started' | 'loading_ended' | 'departed';
export type TrackedStop = typeof loadStops.$inferSelect;
export type TruckPosition = typeof truckPositions.$inferSelect;

export class TrackError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, message: string, explanation: string) {
    super(message);
    this.name = 'TrackError';
    this.code = code;
    this.explanation = explanation;
  }
}

/**
 * Long enough to outlast any single load — the plan's own estimate puts a
 * load's active window in days, not weeks — with a wide margin rather than
 * a load-by-load computed expiry. Revoking (or re-issuing, which supersedes)
 * is the tool for ending one sooner.
 */
const CHECKIN_LINK_TTL_DAYS = 45;

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const MILESTONE_COLUMN = {
  arrived: 'arrivedAt',
  loading_started: 'loadingStartedAt',
  loading_ended: 'loadingEndedAt',
  departed: 'departedAt',
} as const satisfies Record<StopMilestone, keyof typeof loadStops.$inferSelect>;

// ---------------------------------------------------------------------------
// Driver check-in links
// ---------------------------------------------------------------------------

export type CheckinLink = Omit<typeof loadCheckinLinks.$inferSelect, 'tokenHash'>;

export interface CheckinLinkResult {
  link: CheckinLink;
  /** Returned once and never again — only the hash is stored. Same contract `inviteMember` gives its token. */
  token: string;
}

export async function issueCheckinLink(
  s: Scope,
  loadId: string,
  input: { driverId?: string | undefined } = {},
): Promise<CheckinLinkResult> {
  return withTransaction(s, async (tx) => {
    const [load] = await tx.db
      .select({ id: loads.id, reference: loads.reference })
      .from(loads)
      .where(and(eq(loads.id, loadId), eq(loads.orgId, tx.ctx.orgId)));

    if (!load) {
      throw new TrackError('not_found', `load ${loadId} not found`, 'That load no longer exists.');
    }

    if (input.driverId) {
      const [driver] = await tx.db
        .select({ id: drivers.id })
        .from(drivers)
        .where(and(eq(drivers.id, input.driverId), eq(drivers.orgId, tx.ctx.orgId)));
      if (!driver) {
        throw new TrackError(
          'driver_not_found',
          `driver ${input.driverId} not in org`,
          'That driver is not on this account.',
        );
      }
    }

    // Re-issuing supersedes rather than stacking — same reasoning
    // `inviteMember` uses: two live links for one load means the older one
    // still works after the newer is meant to have replaced it.
    await tx.db
      .update(loadCheckinLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(loadCheckinLinks.loadId, loadId), isNull(loadCheckinLinks.revokedAt)));

    const token = randomBytes(32).toString('base64url');

    const [row] = await tx.db
      .insert(loadCheckinLinks)
      .values({
        orgId: tx.ctx.orgId,
        loadId,
        driverId: input.driverId ?? null,
        tokenHash: hashToken(token),
        createdByUserId: tx.ctx.actor.type === 'user' ? tx.ctx.actor.id : null,
        expiresAt: new Date(Date.now() + CHECKIN_LINK_TTL_DAYS * 86_400_000),
      })
      .returning();

    if (!row) throw new Error('checkin link insert returned nothing');

    await recordEvent(tx, 'track.checkin_link_issued', {
      subjectId: loadId,
      payload: { reference: load.reference },
    });

    const { tokenHash: _hash, ...link } = row;
    return { link, token };
  });
}

export async function revokeCheckinLink(s: Scope, loadId: string): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [load] = await tx.db
      .select({ reference: loads.reference })
      .from(loads)
      .where(and(eq(loads.id, loadId), eq(loads.orgId, tx.ctx.orgId)));
    if (!load) {
      throw new TrackError('not_found', `load ${loadId} not found`, 'That load no longer exists.');
    }

    const rows = await tx.db
      .update(loadCheckinLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(loadCheckinLinks.loadId, loadId), isNull(loadCheckinLinks.revokedAt)))
      .returning({ id: loadCheckinLinks.id });
    if (rows.length === 0) return;

    await recordEvent(tx, 'track.checkin_link_revoked', {
      subjectId: loadId,
      payload: { reference: load.reference },
    });
  });
}

/**
 * Look up a live check-in link by its raw token.
 *
 * Same shape as `previewInvitation`: runs without a tenant, looked up by
 * hash rather than scanned, `timingSafeEqual` on the final comparison even
 * though the hash lookup already removes the timing signal.
 */
async function findCheckinLink(
  db: Database,
  token: string,
): Promise<{ orgId: string; loadId: string; driverId: string | null }> {
  const hash = hashToken(token);

  const [row] = await db
    .select({ link: loadCheckinLinks })
    .from(loadCheckinLinks)
    .where(eq(loadCheckinLinks.tokenHash, hash));

  if (!row) {
    throw new TrackError(
      'invalid_token',
      'no checkin link for token',
      'That link is not valid. Ask your dispatcher to send a new one.',
    );
  }

  const stored = Buffer.from(row.link.tokenHash, 'hex');
  const offered = Buffer.from(hash, 'hex');
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
    throw new TrackError('invalid_token', 'token hash mismatch', 'That link is not valid.');
  }

  if (row.link.revokedAt) {
    throw new TrackError(
      'revoked',
      'checkin link revoked',
      'This link was withdrawn. Ask your dispatcher to send a new one.',
    );
  }
  if (row.link.expiresAt.getTime() < Date.now()) {
    throw new TrackError(
      'expired',
      'checkin link expired',
      'This link has expired. Ask your dispatcher to send a new one.',
    );
  }

  return { orgId: row.link.orgId, loadId: row.link.loadId, driverId: row.link.driverId };
}

export interface CheckinStop {
  id: string;
  seq: number;
  type: string;
  city: string;
  state: string;
  facilityName: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  arrivedAt: Date | null;
  loadingStartedAt: Date | null;
  loadingEndedAt: Date | null;
  departedAt: Date | null;
}

export interface CheckinPreview {
  loadReference: number;
  status: string;
  truckLabel: string | null;
  stops: CheckinStop[];
}

/** What a driver sees before tapping anything. Unauthenticated by design — the token is the authority. */
export async function previewCheckin(db: Database, token: string): Promise<CheckinPreview> {
  const found = await findCheckinLink(db, token);

  const [row] = await db
    .select({
      reference: loads.reference,
      status: loads.status,
      truckLabel: trucks.label,
    })
    .from(loads)
    .leftJoin(trucks, eq(trucks.id, loads.truckId))
    .where(eq(loads.id, found.loadId));

  if (!row) throw new TrackError('not_found', 'load gone', 'That load no longer exists.');

  const stops = await db
    .select({
      id: loadStops.id,
      seq: loadStops.seq,
      type: loadStops.type,
      city: loadStops.city,
      state: loadStops.state,
      facilityName: loadStops.facilityName,
      windowStart: loadStops.windowStart,
      windowEnd: loadStops.windowEnd,
      arrivedAt: loadStops.arrivedAt,
      loadingStartedAt: loadStops.loadingStartedAt,
      loadingEndedAt: loadStops.loadingEndedAt,
      departedAt: loadStops.departedAt,
    })
    .from(loadStops)
    .where(eq(loadStops.loadId, found.loadId))
    .orderBy(loadStops.seq);

  return { loadReference: row.reference, status: row.status, truckLabel: row.truckLabel, stops };
}

/**
 * A driver reports one checkpoint on one stop.
 *
 * No ordering enforced between milestones — a driver taps whichever button
 * matches what just happened, and a spotty connection means "loading
 * started" can arrive after "loading ended" was already sent and retried.
 * Refusing an out-of-order report would strand the driver with no fix; the
 * timestamps stand on their own and a carrier reading `load_stops` sees
 * exactly what was tapped, when.
 */
export async function recordStopCheckin(
  db: Database,
  args: {
    token: string;
    stopId: string;
    milestone: StopMilestone;
    occurredAt?: string | undefined;
    correlationId: string;
  },
): Promise<{ stop: TrackedStop }> {
  const found = await findCheckinLink(db, args.token);

  const s: Scope = {
    ctx: {
      orgId: found.orgId,
      actor: { type: 'integration', provider: 'driver_checkin_link' },
      correlationId: args.correlationId,
    },
    db,
  };

  return withTransaction(s, async (tx) => {
    const [stop] = await tx.db
      .select()
      .from(loadStops)
      .where(and(eq(loadStops.id, args.stopId), eq(loadStops.loadId, found.loadId)));

    if (!stop) {
      throw new TrackError(
        'not_found',
        `stop ${args.stopId} not on load ${found.loadId}`,
        'That stop is not on this load.',
      );
    }

    const [load] = await tx.db
      .select({ reference: loads.reference })
      .from(loads)
      .where(eq(loads.id, found.loadId));
    if (!load) throw new Error('load referenced by checkin link is gone');

    const at = args.occurredAt ? new Date(args.occurredAt) : new Date();
    const column = MILESTONE_COLUMN[args.milestone];

    const [updated] = await tx.db
      .update(loadStops)
      .set({
        [column]: at,
        ...(args.milestone === 'arrived' ? { arrivalSource: 'driver_app' } : {}),
        updatedAt: new Date(),
      })
      .where(eq(loadStops.id, stop.id))
      .returning();
    if (!updated) throw new Error('stop checkin update returned nothing');

    await recordEvent(tx, 'load_stop.checkin', {
      subjectId: found.loadId,
      payload: {
        reference: load.reference,
        stopSeq: stop.seq,
        stopType: stop.type,
        city: stop.city,
        state: stop.state,
        milestone: args.milestone,
      },
    });

    return { stop: updated };
  });
}

/**
 * A driver's position ping.
 *
 * Telemetry, not an event — see `schema/track.ts`'s module note — so this
 * writes `truck_positions` and syncs `trucks.current*` without touching
 * `event_log`. No `Scope` needed for the same reason: nothing here produces
 * an auditable action, only a fact about where the truck was.
 */
export async function recordCheckinPosition(
  db: Database,
  args: {
    token: string;
    lat: number;
    lng: number;
    recordedAt?: string | undefined;
  },
): Promise<void> {
  const found = await findCheckinLink(db, args.token);

  const [load] = await db
    .select({ truckId: loads.truckId })
    .from(loads)
    .where(eq(loads.id, found.loadId));

  if (!load?.truckId) {
    throw new TrackError(
      'no_truck',
      `load ${found.loadId} has no truck assigned`,
      'This load has no truck assigned yet, so there is nowhere to record a position.',
    );
  }

  const recordedAt = args.recordedAt ? new Date(args.recordedAt) : new Date();
  const truckId = load.truckId;

  await db.transaction(async (tx) => {
    await tx.insert(truckPositions).values({
      orgId: found.orgId,
      truckId,
      lat: args.lat,
      lng: args.lng,
      recordedAt,
      source: 'driver_app',
    });

    await tx
      .update(trucks)
      .set({
        currentLat: args.lat,
        currentLng: args.lng,
        positionAt: recordedAt,
        positionSource: 'driver_app',
        updatedAt: new Date(),
      })
      .where(eq(trucks.id, truckId));
  });
}

// ---------------------------------------------------------------------------
// Broker visibility links
// ---------------------------------------------------------------------------

export type VisibilityLink = Omit<typeof loadVisibilityLinks.$inferSelect, 'tokenHash'>;

export interface VisibilityLinkResult {
  link: VisibilityLink;
  token: string;
}

export async function issueVisibilityLink(
  s: Scope,
  loadId: string,
): Promise<VisibilityLinkResult> {
  return withTransaction(s, async (tx) => {
    const [load] = await tx.db
      .select({ id: loads.id, reference: loads.reference })
      .from(loads)
      .where(and(eq(loads.id, loadId), eq(loads.orgId, tx.ctx.orgId)));

    if (!load) {
      throw new TrackError('not_found', `load ${loadId} not found`, 'That load no longer exists.');
    }

    await tx.db
      .update(loadVisibilityLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(loadVisibilityLinks.loadId, loadId), isNull(loadVisibilityLinks.revokedAt)));

    const token = randomBytes(32).toString('base64url');

    const [row] = await tx.db
      .insert(loadVisibilityLinks)
      .values({
        orgId: tx.ctx.orgId,
        loadId,
        createdByUserId: tx.ctx.actor.type === 'user' ? tx.ctx.actor.id : null,
        tokenHash: hashToken(token),
      })
      .returning();

    if (!row) throw new Error('visibility link insert returned nothing');

    await recordEvent(tx, 'track.visibility_link_issued', {
      subjectId: loadId,
      payload: { reference: load.reference },
    });

    const { tokenHash: _hash, ...link } = row;
    return { link, token };
  });
}

export async function revokeVisibilityLink(s: Scope, loadId: string): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [load] = await tx.db
      .select({ reference: loads.reference })
      .from(loads)
      .where(and(eq(loads.id, loadId), eq(loads.orgId, tx.ctx.orgId)));
    if (!load) {
      throw new TrackError('not_found', `load ${loadId} not found`, 'That load no longer exists.');
    }

    const rows = await tx.db
      .update(loadVisibilityLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(loadVisibilityLinks.loadId, loadId), isNull(loadVisibilityLinks.revokedAt)))
      .returning({ id: loadVisibilityLinks.id });
    if (rows.length === 0) return;

    await recordEvent(tx, 'track.visibility_link_revoked', {
      subjectId: loadId,
      payload: { reference: load.reference },
    });
  });
}

/**
 * Free time before detention accrues, when a broker has no override of their
 * own. Two hours is the near-universal industry rule of thumb, not a figure
 * this plan researched — see `schema/brokers.ts`'s note on
 * `detentionFreeMinutes`.
 */
export const DEFAULT_DETENTION_FREE_MINUTES = 120;

export interface TrackingStop {
  seq: number;
  type: string;
  city: string;
  state: string;
  facilityName: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  arrivedAt: Date | null;
  loadingStartedAt: Date | null;
  loadingEndedAt: Date | null;
  departedAt: Date | null;
  /**
   * Minutes over the broker's free time, or null if the truck has not
   * arrived yet. Computed against `departedAt`, or against now while
   * `stillOnSite` — a stop already departed still shows what it cost, which
   * is the evidence a detention dispute actually needs.
   */
  detentionMinutes: number | null;
  stillOnSite: boolean;
}

export interface TrackingEta {
  stopSeq: number;
  milesRemaining: number;
  arrivalAt: Date;
}

export interface TrackingView {
  orgName: string;
  loadReference: number;
  status: string;
  equipment: string;
  truck: {
    label: string | null;
    currentCity: string | null;
    currentState: string | null;
    positionAt: Date | null;
  } | null;
  stops: TrackingStop[];
  /**
   * Screening-grade, not invoicing-grade — see `geo.ts`'s module note. Null
   * whenever there is nothing left to estimate against: no truck position,
   * no next stop with coordinates, or nothing left to arrive at.
   */
  eta: TrackingEta | null;
}

/**
 * What a broker sees. Read-only, unauthenticated. Detention and ETA both
 * answer open questions from plan section 7 — per-broker free time, and the
 * dispatcher core's haversine approximation reused rather than waiting on
 * Phase 3's routing-provider decision.
 */
export async function previewTracking(db: Database, token: string): Promise<TrackingView> {
  const hash = hashToken(token);

  const [row] = await db
    .select({ link: loadVisibilityLinks, orgName: orgs.name })
    .from(loadVisibilityLinks)
    .innerJoin(orgs, eq(orgs.id, loadVisibilityLinks.orgId))
    .where(eq(loadVisibilityLinks.tokenHash, hash));

  if (!row) {
    throw new TrackError(
      'invalid_token',
      'no visibility link for token',
      'That tracking link is not valid.',
    );
  }

  const stored = Buffer.from(row.link.tokenHash, 'hex');
  const offered = Buffer.from(hash, 'hex');
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
    throw new TrackError('invalid_token', 'token hash mismatch', 'That tracking link is not valid.');
  }

  if (row.link.revokedAt) {
    throw new TrackError('revoked', 'visibility link revoked', 'This tracking link was withdrawn.');
  }
  if (row.link.expiresAt && row.link.expiresAt.getTime() < Date.now()) {
    throw new TrackError('expired', 'visibility link expired', 'This tracking link has expired.');
  }

  const [load] = await db
    .select({
      reference: loads.reference,
      status: loads.status,
      equipment: loads.equipment,
      truckLabel: trucks.label,
      currentCity: trucks.currentCity,
      currentState: trucks.currentState,
      currentLat: trucks.currentLat,
      currentLng: trucks.currentLng,
      positionAt: trucks.positionAt,
      detentionFreeMinutes: brokers.detentionFreeMinutes,
    })
    .from(loads)
    .leftJoin(trucks, eq(trucks.id, loads.truckId))
    .leftJoin(brokers, eq(brokers.id, loads.brokerId))
    .where(eq(loads.id, row.link.loadId));

  if (!load) throw new TrackError('not_found', 'load gone', 'That load no longer exists.');

  const stopRows = await db
    .select({
      seq: loadStops.seq,
      type: loadStops.type,
      city: loadStops.city,
      state: loadStops.state,
      facilityName: loadStops.facilityName,
      lat: loadStops.lat,
      lng: loadStops.lng,
      windowStart: loadStops.windowStart,
      windowEnd: loadStops.windowEnd,
      arrivedAt: loadStops.arrivedAt,
      loadingStartedAt: loadStops.loadingStartedAt,
      loadingEndedAt: loadStops.loadingEndedAt,
      departedAt: loadStops.departedAt,
    })
    .from(loadStops)
    .where(eq(loadStops.loadId, row.link.loadId))
    .orderBy(loadStops.seq);

  const freeMinutes = load.detentionFreeMinutes ?? DEFAULT_DETENTION_FREE_MINUTES;
  const now = Date.now();

  const stops: TrackingStop[] = stopRows.map((stop) => {
    let detentionMinutes: number | null = null;
    const stillOnSite = stop.arrivedAt !== null && stop.departedAt === null;

    if (stop.arrivedAt) {
      const end = stop.departedAt ?? new Date(now);
      const dwellMinutes = Math.round((end.getTime() - stop.arrivedAt.getTime()) / 60_000);
      detentionMinutes = Math.max(0, dwellMinutes - freeMinutes);
    }

    return {
      seq: stop.seq,
      type: stop.type,
      city: stop.city,
      state: stop.state,
      facilityName: stop.facilityName,
      windowStart: stop.windowStart,
      windowEnd: stop.windowEnd,
      arrivedAt: stop.arrivedAt,
      loadingStartedAt: stop.loadingStartedAt,
      loadingEndedAt: stop.loadingEndedAt,
      departedAt: stop.departedAt,
      detentionMinutes,
      stillOnSite,
    };
  });

  // The next stop nobody has reached yet, with coordinates to aim at.
  const nextStop = stopRows.find((s) => s.arrivedAt === null && s.lat !== null && s.lng !== null);
  const eta: TrackingEta | null =
    nextStop && load.currentLat !== null && load.currentLng !== null
      ? {
          stopSeq: nextStop.seq,
          ...estimatedArrival(
            { lat: load.currentLat, lng: load.currentLng },
            { lat: nextStop.lat!, lng: nextStop.lng! },
          ),
        }
      : null;

  return {
    orgName: row.orgName,
    loadReference: load.reference,
    status: load.status,
    equipment: load.equipment,
    truck: load.truckLabel
      ? {
          label: load.truckLabel,
          currentCity: load.currentCity,
          currentState: load.currentState,
          positionAt: load.positionAt,
        }
      : null,
    stops,
    eta,
  };
}

/** The most recent pings for a truck, newest first. For a breadcrumb trail, not the fast "where is it now" read — that stays `trucks.current*`. */
export async function truckPositionHistory(
  s: Scope,
  truckId: string,
  limit = 50,
): Promise<TruckPosition[]> {
  return s.db
    .select()
    .from(truckPositions)
    .where(and(eq(truckPositions.orgId, s.ctx.orgId), eq(truckPositions.truckId, truckId)))
    .orderBy(desc(truckPositions.recordedAt))
    .limit(Math.min(limit, 200));
}

// ---------------------------------------------------------------------------
// Exception alerts
// ---------------------------------------------------------------------------
//
// "Automatic status updates, escalating to a human on exceptions" — Track's
// own promise, PHASE_2_PLAN.md section 4's fifth line item. Runs with no
// tenant, a sweep across every org, same shape `expireStaleInvitations`
// already has for housekeeping — this is a scheduled job's work, not a
// request's.

export interface ExceptionCandidate {
  orgId: string;
  loadId: string;
  reference: number;
  /** Whichever is most recent of dispatch, a stop checkpoint, or a position ping. */
  lastActivityAt: Date;
  hoursSinceActivity: number;
}

/**
 * Loads sitting in `in_transit` with nothing reported in `thresholdHours`.
 *
 * "Activity" is whichever is most recent of: `dispatchedAt` (the baseline —
 * a load dispatched and then never touched is still caught), a
 * `load_stops` checkpoint, or a `truck_positions` ping. Computed in three
 * queries and joined in memory rather than one query with `GREATEST`
 * across subqueries — a small carrier's `in_transit` count is a handful of
 * rows, and three readable queries beat one query nobody wants to debug at
 * 2am when the alert didn't fire.
 */
export async function findExceptionCandidates(
  db: Database,
  thresholdHours: number,
): Promise<ExceptionCandidate[]> {
  const cutoff = new Date(Date.now() - thresholdHours * 3_600_000);

  const inTransit = await db
    .select({
      orgId: loads.orgId,
      loadId: loads.id,
      reference: loads.reference,
      truckId: loads.truckId,
      dispatchedAt: loads.dispatchedAt,
    })
    .from(loads)
    .where(and(eq(loads.status, 'in_transit'), isNull(loads.deletedAt)));

  if (inTransit.length === 0) return [];

  const loadIds = inTransit.map((l) => l.loadId);
  const truckIds = [...new Set(inTransit.map((l) => l.truckId).filter((id): id is string => id !== null))];

  const stopRows = await db
    .select({
      loadId: loadStops.loadId,
      arrivedAt: loadStops.arrivedAt,
      loadingStartedAt: loadStops.loadingStartedAt,
      loadingEndedAt: loadStops.loadingEndedAt,
      departedAt: loadStops.departedAt,
    })
    .from(loadStops)
    .where(inArray(loadStops.loadId, loadIds));

  const latestStopByLoad = new Map<string, Date>();
  for (const row of stopRows) {
    for (const t of [row.arrivedAt, row.loadingStartedAt, row.loadingEndedAt, row.departedAt]) {
      if (!t) continue;
      const current = latestStopByLoad.get(row.loadId);
      if (!current || t > current) latestStopByLoad.set(row.loadId, t);
    }
  }

  const latestPositionByTruck = new Map<string, Date>();
  if (truckIds.length > 0) {
    const positionRows = await db
      .select({ truckId: truckPositions.truckId, recordedAt: truckPositions.recordedAt })
      .from(truckPositions)
      .where(inArray(truckPositions.truckId, truckIds))
      .orderBy(desc(truckPositions.recordedAt));
    // Ordered newest first, so the first row seen per truck is its latest.
    for (const row of positionRows) {
      if (!latestPositionByTruck.has(row.truckId)) latestPositionByTruck.set(row.truckId, row.recordedAt);
    }
  }

  const candidates: ExceptionCandidate[] = [];
  for (const load of inTransit) {
    const times = [
      load.dispatchedAt,
      latestStopByLoad.get(load.loadId) ?? null,
      load.truckId ? (latestPositionByTruck.get(load.truckId) ?? null) : null,
    ].filter((t): t is Date => t !== null);

    // No dispatchedAt and nothing reported: `createLoad` and
    // `updateLoadStatus` both stamp `dispatchedAt` on the way to
    // `in_transit`, so this should not happen — but the scan should not
    // throw over a data bug it did not cause. Skipping, not alerting,
    // because there is no baseline to measure "quiet" against.
    if (times.length === 0) continue;

    const lastActivityAt = times.reduce((latest, t) => (t > latest ? t : latest));
    if (lastActivityAt > cutoff) continue;

    candidates.push({
      orgId: load.orgId,
      loadId: load.loadId,
      reference: load.reference,
      lastActivityAt,
      hoursSinceActivity: Math.floor((Date.now() - lastActivityAt.getTime()) / 3_600_000),
    });
  }

  return candidates;
}

/**
 * Fire `track.exception_alerted` for one candidate — unless it already was,
 * since the activity that made it a candidate.
 *
 * That "since" is the whole dedup rule: the scan runs every few minutes, and
 * without it a load stuck at four hours quiet would raise a new alert every
 * pass. Checking for a prior alert *after* `lastActivityAt` means a load
 * that goes quiet, gets alerted, then reports in and goes quiet again gets a
 * second alert — the silence resets, so the escalation does too. A load
 * that never reports again gets exactly one.
 */
export async function raiseExceptionAlert(
  db: Database,
  candidate: ExceptionCandidate,
): Promise<boolean> {
  const s: Scope = {
    ctx: {
      orgId: candidate.orgId,
      actor: { type: 'system', name: 'exception-scan' },
      correlationId: randomUUID(),
    },
    db,
  };

  return withTransaction(s, async (tx) => {
    const [already] = await tx.db
      .select({ seq: eventLog.seq })
      .from(eventLog)
      .where(
        and(
          eq(eventLog.orgId, candidate.orgId),
          eq(eventLog.subjectId, candidate.loadId),
          eq(eventLog.verb, 'track.exception_alerted'),
          gt(eventLog.occurredAt, candidate.lastActivityAt),
        ),
      )
      .limit(1);
    if (already) return false;

    await recordEvent(tx, 'track.exception_alerted', {
      subjectId: candidate.loadId,
      payload: { reference: candidate.reference, hoursSinceActivity: candidate.hoursSinceActivity },
    });
    return true;
  });
}
