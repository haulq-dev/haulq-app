/**
 * Loads.
 *
 * Same shape as trucks and drivers — validate, call a repository, return — with
 * one addition that earns its place: **translating what the database refuses.**
 *
 * The load state machine and its consistency rules live in
 * `sql/post/0300_load_status.sql`, because four different surfaces write
 * `loads.status` and a rule in one service's code is a rule the other three
 * break. The cost of putting them there is that a violation arrives as a
 * Postgres error naming a constraint, and
 *
 *     new row for relation "loads" violates check constraint
 *     "loads_dispatched_has_truck"
 *
 * is not a sentence to show a carrier. Guardrail 6 asks for human-readable
 * explanations and that applies to refusals too, so this file maps them.
 *
 * The trigger-raised ones are already readable — "load 1042 cannot move
 * backwards from booked to prospect" — and are passed through rather than
 * rewritten, so the message a carrier reads is the message the database
 * actually produced.
 */

import {
  AssignLoadSchema,
  CreateLoadSchema,
  UpdateLoadStatusSchema,
  UpdateLoadStopSchema,
} from '@haulq/contracts';
import {
  assignLoad,
  createLoad,
  CursorError,
  getLoad,
  listLoads,
  loadCounts,
  LoadError,
  loadMargin,
  updateLoadStatus,
  updateLoadStop,
  type LoadStatus,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

/** Postgres SQLSTATEs this route knows how to explain. */
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
/** What `0300_load_status.sql` raises with `using errcode = 'restrict_violation'`. */
const RESTRICT_VIOLATION = '23001';

/**
 * Constraint name → the sentence a carrier should read.
 *
 * Keyed on the constraint rather than parsed out of the message, because the
 * message text is Postgres's and changes between versions. The name is ours.
 */
const CHECK_EXPLANATION: Record<string, string> = {
  loads_dispatched_has_truck:
    'A load cannot be dispatched without naming the truck running it. Assign a truck first.',
  loads_booked_has_timestamp:
    'A booked load needs the date it was booked. This is a bug — please report it.',
  loads_delivered_has_timestamp:
    'A delivered load needs the date it was delivered. This is a bug — please report it.',
  loads_cancelled_has_timestamp:
    'A cancelled load needs the date it was cancelled. This is a bug — please report it.',
  load_stops_window_ordered: 'A stop window ends before it starts.',
  loads_miles_non_negative: 'Miles cannot be negative.',
};

interface PgError {
  code?: string;
  constraint_name?: string;
  message?: string;
}

function rethrow(err: unknown): never {
  if (err instanceof LoadError) {
    const status = err.code === 'not_found' ? 404 : 400;
    throw new HttpError(status, err.code, err.explanation);
  }

  if (err instanceof CursorError) {
    throw new HttpError(400, err.code, err.explanation);
  }

  const pg = err as PgError;

  if (pg.code === RESTRICT_VIOLATION) {
    // The trigger writes these for people, not for logs. Passing it through
    // means one sentence to maintain instead of two that can disagree.
    throw new HttpError(
      409,
      'illegal_transition',
      pg.message ?? 'That change is not allowed for this load.',
    );
  }

  if (pg.code === CHECK_VIOLATION) {
    const explanation =
      CHECK_EXPLANATION[pg.constraint_name ?? ''] ??
      'That change would leave the load in a state HaulQ does not allow.';
    throw new HttpError(422, pg.constraint_name ?? 'check_violation', explanation);
  }

  if (pg.code === UNIQUE_VIOLATION) {
    if (pg.constraint_name === 'loads_org_source_key') {
      throw new HttpError(
        409,
        'duplicate_posting',
        'This posting is already on the board as an existing load.',
      );
    }
    throw new HttpError(409, 'duplicate', 'That load already exists.');
  }

  throw err;
}

function badRequest(issues: { path: (string | number)[]; message: string }[]): never {
  throw new HttpError(
    400,
    'invalid_request',
    issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
  );
}

export async function loadRoutes(app: FastifyInstance) {
  app.get('/v1/loads', async (request) => {
    const s = await requireScope(request);
    const q = request.query as { status?: string; truckId?: string; limit?: string; cursor?: string };

    // Repeatable as `?status=booked&status=dispatched` or comma-separated —
    // both are what a hand-written link tends to contain.
    const status = q.status
      ? (q.status.split(',').map((x) => x.trim()).filter(Boolean) as LoadStatus[])
      : undefined;

    try {
      const { items, nextCursor } = await listLoads(s, {
        ...(status?.length ? { status } : {}),
        ...(q.truckId ? { truckId: q.truckId } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      });

      return { items, counts: await loadCounts(s), nextCursor };
    } catch (err) {
      rethrow(err);
    }
  });

  app.get('/v1/loads/:id', async (request) => {
    const s = await requireScope(request);
    const { id } = request.params as { id: string };
    const load = await getLoad(s, id);
    if (!load) throw new HttpError(404, 'not_found', 'That load no longer exists.');
    return load;
  });

  /**
   * What this one load actually made. PHASE_1_PLAN.md section 4's per-load
   * gap — a single-row read, not a new aggregation engine.
   */
  app.get('/v1/loads/:id/margin', async (request) => {
    const s = await requireScope(request);
    const { id } = request.params as { id: string };
    const margin = await loadMargin(s, id);
    if (!margin) throw new HttpError(404, 'not_found', 'That load no longer exists.');
    return margin;
  });

  app.post('/v1/loads', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');

    const parsed = CreateLoadSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return reply.code(201).send(await createLoad(s, parsed.data));
    } catch (err) {
      rethrow(err);
    }
  });

  app.patch('/v1/loads/:id/status', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = UpdateLoadStatusSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await updateLoadStatus(s, id, parsed.data);
    } catch (err) {
      rethrow(err);
    }
  });

  app.patch('/v1/loads/:id/assignment', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = AssignLoadSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await assignLoad(s, id, parsed.data);
    } catch (err) {
      rethrow(err);
    }
  });

  /**
   * Correct a stop's coordinates or appointment window after the load
   * already exists. `PHASE_3A_ROUTES_WALKTHROUGH.md` §1 named the gap this
   * closes — Routes' feasibility check depends on both and `CreateLoadSchema`
   * only ever sets them once, at creation.
   */
  app.patch('/v1/loads/:id/stops/:stopId', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id, stopId } = request.params as { id: string; stopId: string };

    const parsed = UpdateLoadStopSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await updateLoadStop(s, id, stopId, parsed.data);
    } catch (err) {
      rethrow(err);
    }
  });
}
