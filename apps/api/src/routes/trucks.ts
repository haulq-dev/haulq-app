/**
 * Trucks.
 *
 * The first route with a write, and the pattern every later one follows:
 * `requireScope` → validate → call a repository → return.
 *
 * Note what is *not* here. No SQL, no transaction, no event recording. Those
 * live in `@haulq/db`'s truck repository, together, so that the row and the
 * event describing it cannot be written apart. See the note at the top of that
 * file.
 *
 * Validation happens through Fastify's own `schema` option now, using the
 * same Zod schemas from `@haulq/contracts` the API always validated against —
 * not a second copy. That is what lets `/documentation` (wired in
 * `server.ts`) describe these routes accurately: the generated doc and the
 * running validation are the same object. `loads.ts` follows the same
 * pattern; the other route files still validate by hand and are not yet in
 * the generated doc.
 */

import {
  CreateTruckSchema,
  PageQuerySchema,
  SetTruckActiveSchema,
  SetTruckMotiveVehicleSchema,
  UpdateTruckSchema,
} from '@haulq/contracts';
import {
  createTruck,
  CursorError,
  listTrucks,
  setTruckActive,
  setTruckMotiveVehicleId,
  TruckError,
  updateTruck,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

const IdParamSchema = z.object({ id: z.string().uuid() });

function rethrow(err: unknown): never {
  if (err instanceof TruckError) {
    throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.explanation);
  }
  if (err instanceof CursorError) {
    throw new HttpError(400, err.code, err.explanation);
  }
  throw err;
}

export async function truckRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/trucks',
    { schema: { tags: ['Trucks'], summary: 'List trucks', querystring: PageQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const { cursor, limit } = request.query;
      try {
        return await listTrucks(s, { ...(cursor ? { cursor } : {}), limit });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/trucks',
    { schema: { tags: ['Trucks'], summary: 'Add a truck', body: CreateTruckSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const truck = await createTruck(s, request.body);
      return reply.code(201).send(truck);
    },
  );

  server.patch(
    '/v1/trucks/:id/motive-vehicle',
    {
      schema: {
        tags: ['Trucks'],
        summary: "Set, or clear, a truck's matched Motive vehicle",
        params: IdParamSchema,
        body: SetTruckMotiveVehicleSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;
      try {
        return await setTruckMotiveVehicleId(s, id, request.body.motiveVehicleId);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.patch(
    '/v1/trucks/:id',
    {
      schema: {
        tags: ['Trucks'],
        summary: 'Update a truck',
        params: IdParamSchema,
        body: UpdateTruckSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;
      try {
        return await updateTruck(s, id, request.body);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /**
   * Take a truck out of service, or bring it back — not `DELETE`. See
   * `contracts`' `SetTruckActiveSchema` and `repositories/trucks.ts`'s
   * `setTruckActive` for why: a truck stays referenced by loads, drivers
   * and telemetry for as long as it was ever run.
   */
  server.patch(
    '/v1/trucks/:id/active',
    {
      schema: {
        tags: ['Trucks'],
        summary: 'Take a truck in or out of service',
        params: IdParamSchema,
        body: SetTruckActiveSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;
      try {
        return await setTruckActive(s, id, request.body.active, request.body.reason);
      } catch (err) {
        rethrow(err);
      }
    },
  );
}
