/**
 * "How much are we using HaulQ for" — one org, one month.
 *
 * No role restriction, unlike most write routes: this is a read, and every
 * member (owner, dispatcher, accountant) has reason to see it — same
 * shape `insights.ts` already takes.
 */

import { monthlyUsage } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { requireScope } from '../plugins/request-context.ts';

export async function usageRoutes(app: FastifyInstance) {
  app.get(
    '/v1/usage',
    { schema: { tags: ['Usage'], summary: "This org's usage for the current month" } },
    async (request) => {
      const s = await requireScope(request);
      return monthlyUsage(s);
    },
  );
}
