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
 *
 * Validation happens through Fastify's own `schema` option, the same as
 * `trucks.ts` — see that file's module note for why. The Postgres-refusal
 * translation below is unrelated to that and unaffected by it: it only ever
 * runs after a request has already passed schema validation.
 */

import {
  AssignLoadSchema,
  CreateLoadSchema,
  PageQuerySchema,
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
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
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

const IdParamSchema = z.object({ id: z.string().uuid() });
const StopParamSchema = z.object({ id: z.string().uuid(), stopId: z.string().uuid() });

/**
 * `status`/`truckId` stay plain, unconstrained strings — same as before this
 * file validated through Fastify at all. `status` in particular is read as
 * "?status=booked&status=dispatched" or comma-separated below, and either
 * shape is a valid string here.
 */
const ListLoadsQuerySchema = PageQuerySchema.extend({
  status: z.string().optional(),
  truckId: z.string().optional(),
});

export async function loadRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/loads',
    { schema: { tags: ['Loads'], summary: 'List loads', querystring: ListLoadsQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const { status: statusParam, truckId, cursor, limit } = request.query;

      // Repeatable as `?status=booked&status=dispatched` or comma-separated —
      // both are what a hand-written link tends to contain.
      const status = statusParam
        ? (statusParam.split(',').map((x) => x.trim()).filter(Boolean) as LoadStatus[])
        : undefined;

      try {
        const { items, nextCursor } = await listLoads(s, {
          ...(status?.length ? { status } : {}),
          ...(truckId ? { truckId } : {}),
          limit,
          ...(cursor ? { cursor } : {}),
        });

        return { items, counts: await loadCounts(s), nextCursor };
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.get(
    '/v1/loads/:id',
    { schema: { tags: ['Loads'], summary: 'Get a load', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      const { id } = request.params;
      const load = await getLoad(s, id);
      if (!load) throw new HttpError(404, 'not_found', 'That load no longer exists.');
      return load;
    },
  );

  /**
   * What this one load actually made. PHASE_1_PLAN.md section 4's per-load
   * gap — a single-row read, not a new aggregation engine.
   */
  server.get(
    '/v1/loads/:id/margin',
    { schema: { tags: ['Loads'], summary: "A load's margin", params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      const { id } = request.params;
      const margin = await loadMargin(s, id);
      if (!margin) throw new HttpError(404, 'not_found', 'That load no longer exists.');
      return margin;
    },
  );

  server.post(
    '/v1/loads',
    { schema: { tags: ['Loads'], summary: 'Create a load', body: CreateLoadSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      try {
        return reply.code(201).send(await createLoad(s, request.body));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.patch(
    '/v1/loads/:id/status',
    {
      schema: {
        tags: ['Loads'],
        summary: "Move a load's status",
        params: IdParamSchema,
        body: UpdateLoadStatusSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;
      try {
        return await updateLoadStatus(s, id, request.body);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.patch(
    '/v1/loads/:id/assignment',
    {
      schema: {
        tags: ['Loads'],
        summary: 'Assign a truck and driver to a load',
        params: IdParamSchema,
        body: AssignLoadSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;
      try {
        return await assignLoad(s, id, request.body);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /**
   * Correct a stop's coordinates or appointment window after the load
   * already exists. `PHASE_3A_ROUTES_WALKTHROUGH.md` §1 named the gap this
   * closes — Routes' feasibility check depends on both and `CreateLoadSchema`
   * only ever sets them once, at creation.
   */
  server.patch(
    '/v1/loads/:id/stops/:stopId',
    {
      schema: {
        tags: ['Loads'],
        summary: "Correct a stop's coordinates or appointment window",
        params: StopParamSchema,
        body: UpdateLoadStopSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id, stopId } = request.params;
      try {
        return await updateLoadStop(s, id, stopId, request.body);
      } catch (err) {
        rethrow(err);
      }
    },
  );
}
