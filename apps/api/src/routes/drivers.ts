/**
 * Drivers.
 *
 * Same shape as trucks: validate, call a repository, return. The expiring-
 * credentials endpoint is here rather than under a notifications route because
 * it is a property of the fleet, and the onboarding screen shows it before any
 * notification system exists to send it.
 */

import { CreateDriverSchema } from '@haulq/contracts';
import { createDriver, CursorError, expiringCredentials, listDrivers } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

export async function driverRoutes(app: FastifyInstance) {
  app.get('/v1/drivers', async (request) => {
    const s = await requireScope(request);
    const q = request.query as { cursor?: string; limit?: string };
    try {
      return await listDrivers(s, {
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      });
    } catch (err) {
      if (err instanceof CursorError) throw new HttpError(400, err.code, err.explanation);
      throw err;
    }
  });

  app.post('/v1/drivers', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');

    const parsed = CreateDriverSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    return reply.code(201).send(await createDriver(s, parsed.data));
  });

  /**
   * Credentials expiring soon.
   *
   * An expired medical card puts a driver out of service, which is a load that
   * cannot be covered rather than a paperwork problem. Surfacing it 30 days out
   * is the difference between a renewal and a cancellation.
   */
  app.get('/v1/drivers/expiring', async (request) => {
    const s = await requireScope(request);
    const q = request.query as { days?: string };
    const days = q.days ? Number(q.days) : 30;

    if (!Number.isFinite(days) || days < 0 || days > 365) {
      throw new HttpError(
        400,
        'invalid_request',
        'The "days" window must be a number between 0 and 365.',
      );
    }

    const items = await expiringCredentials(s, days);
    return {
      items: items.map((i) => ({
        driverId: i.driver.id,
        driverName: i.driver.fullName,
        what: i.what,
        expiresAt: i.expiresAt,
      })),
    };
  });
}
