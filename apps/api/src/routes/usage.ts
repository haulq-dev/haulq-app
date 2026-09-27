/**
 * "How much are we using HaulQ for" — one org, one month.
 *
 * Office roles (owner, dispatcher, accountant), the same as `insights.ts`.
 * A driver login has no reason to see account-wide volumes.
 */

import { monthlyUsage } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { requireRole, requireScope } from '../plugins/request-context.ts';

export async function usageRoutes(app: FastifyInstance) {
  app.get(
    '/v1/usage',
    { schema: { tags: ['Usage'], summary: "This org's usage for the current month" } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher', 'accountant');
      return monthlyUsage(s);
    },
  );
}
