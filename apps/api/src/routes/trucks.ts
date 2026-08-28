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
 */

import {
  CreateTruckSchema,
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
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

function rethrow(err: unknown): never {
  if (err instanceof TruckError) {
    throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.explanation);
  }
  if (err instanceof CursorError) {
    throw new HttpError(400, err.code, err.explanation);
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

export async function truckRoutes(app: FastifyInstance) {
  app.get('/v1/trucks', async (request) => {
    const s = await requireScope(request);
    const q = request.query as { cursor?: string; limit?: string };
    try {
      return await listTrucks(s, {
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      });
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/trucks', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');

    const parsed = CreateTruckSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const truck = await createTruck(s, parsed.data);
    return reply.code(201).send(truck);
  });

  app.patch('/v1/trucks/:id/motive-vehicle', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = SetTruckMotiveVehicleSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await setTruckMotiveVehicleId(s, id, parsed.data.motiveVehicleId);
    } catch (err) {
      rethrow(err);
    }
  });

  app.patch('/v1/trucks/:id', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = UpdateTruckSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await updateTruck(s, id, parsed.data);
    } catch (err) {
      rethrow(err);
    }
  });

  /**
   * Take a truck out of service, or bring it back — not `DELETE`. See
   * `contracts`' `SetTruckActiveSchema` and `repositories/trucks.ts`'s
   * `setTruckActive` for why: a truck stays referenced by loads, drivers
   * and telemetry for as long as it was ever run.
   */
  app.patch('/v1/trucks/:id/active', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = SetTruckActiveSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await setTruckActive(s, id, parsed.data.active, parsed.data.reason);
    } catch (err) {
      rethrow(err);
    }
  });
}
