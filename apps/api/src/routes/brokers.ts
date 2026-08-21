/**
 * Brokers.
 *
 * One route, deliberately. Most of a broker's record is written implicitly
 * by `resolveBroker` when a load names one — see `repositories/loads.ts` —
 * and nothing here duplicates that. This is the one field a carrier sets on
 * purpose: the per-broker detention free time PHASE_2_PLAN.md section 7
 * landed on.
 */

import { UpdateBrokerDetentionSchema } from '@haulq/contracts';
import { BrokerError, updateBrokerDetentionThreshold } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

function rethrow(err: unknown): never {
  if (err instanceof BrokerError) {
    throw new HttpError(err.code === 'not_found' ? 404 : 400, err.code, err.explanation);
  }
  throw err;
}

export async function brokerRoutes(app: FastifyInstance) {
  app.patch('/v1/brokers/:id/detention-threshold', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = UpdateBrokerDetentionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }

    try {
      return await updateBrokerDetentionThreshold(s, id, parsed.data.freeMinutes);
    } catch (err) {
      rethrow(err);
    }
  });
}
