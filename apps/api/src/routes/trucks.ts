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

import { CreateTruckSchema } from '@haulq/contracts';
import { createTruck, listTrucks } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

export async function truckRoutes(app: FastifyInstance) {
  app.get('/v1/trucks', async (request) => {
    const s = await requireScope(request);
    const items = await listTrucks(s);
    return { items, nextCursor: null };
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
}
