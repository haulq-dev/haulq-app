/**
 * Drivers.
 *
 * Same shape as trucks: validate, call a repository, return. The expiring-
 * credentials endpoint is here rather than under a notifications route because
 * it is a property of the fleet, and the onboarding screen shows it before any
 * notification system exists to send it.
 */

import { CreateDriverSchema, PageQuerySchema, UpdateDriverSchema } from '@haulq/contracts';
import {
  createDriver,
  CursorError,
  DriverError,
  expiringCredentials,
  listDrivers,
  removeDriver,
  updateDriver,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

const ExpiringQuerySchema = z.object({
  days: z.coerce.number().int().min(0).max(365).default(30),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

function rethrow(err: unknown): never {
  if (err instanceof DriverError) {
    throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.explanation);
  }
  throw err;
}

export async function driverRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/drivers',
    { schema: { tags: ['Drivers'], summary: 'List drivers', querystring: PageQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const { cursor, limit } = request.query;
      try {
        return await listDrivers(s, { ...(cursor ? { cursor } : {}), limit });
      } catch (err) {
        if (err instanceof CursorError) throw new HttpError(400, err.code, err.explanation);
        throw err;
      }
    },
  );

  server.post(
    '/v1/drivers',
    { schema: { tags: ['Drivers'], summary: 'Add a driver', body: CreateDriverSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      return reply.code(201).send(await createDriver(s, request.body));
    },
  );

  server.patch(
    '/v1/drivers/:id',
    {
      schema: {
        tags: ['Drivers'],
        summary: 'Update a driver',
        params: IdParamSchema,
        body: UpdateDriverSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      try {
        return await updateDriver(s, request.params.id, request.body);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /**
   * Off the roster, not erased: past loads keep the name they ran under.
   * Refused while the driver is on a load that still needs them.
   */
  server.delete(
    '/v1/drivers/:id',
    { schema: { tags: ['Drivers'], summary: 'Take a driver off the roster', params: IdParamSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      try {
        await removeDriver(s, request.params.id);
      } catch (err) {
        rethrow(err);
      }
      return reply.code(204).send();
    },
  );

  /**
   * Credentials expiring soon.
   *
   * An expired medical card puts a driver out of service, which is a load that
   * cannot be covered rather than a paperwork problem. Surfacing it 30 days out
   * is the difference between a renewal and a cancellation.
   */
  server.get(
    '/v1/drivers/expiring',
    { schema: { tags: ['Drivers'], summary: 'Credentials expiring soon', querystring: ExpiringQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const { days } = request.query;

      const items = await expiringCredentials(s, days);
      return {
        items: items.map((i) => ({
          driverId: i.driver.id,
          driverName: i.driver.fullName,
          what: i.what,
          expiresAt: i.expiresAt,
        })),
      };
    },
  );
}
