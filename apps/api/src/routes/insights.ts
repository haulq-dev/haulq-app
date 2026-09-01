/**
 * Insights.
 *
 * Read-only, so no role gate beyond the tenant scope — an accountant should see
 * profitability; that is the job.
 *
 * One request returns the whole screen. Four round trips for four panels on a
 * page a carrier opens once a week is four chances for one to fail and leave a
 * half-rendered dashboard.
 */

import {
  insightsSummary,
  paymentPerformance,
  revenueByBroker,
  revenueByLane,
  revenueByTruck,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireScope } from '../plugins/request-context.ts';

const InsightsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(730).default(90),
});

export async function insightsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/insights',
    {
      schema: {
        tags: ['Insights'],
        summary: 'Revenue, margin and payment-performance rollups',
        querystring: InsightsQuerySchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      const { days } = request.query;

      const [summary, byBroker, byLane, byTruck, payment] = await Promise.all([
        insightsSummary(s, { days }),
        revenueByBroker(s, { days }),
        revenueByLane(s, { days }),
        revenueByTruck(s, { days }),
        paymentPerformance(s, { days }),
      ]);

      return { summary, byBroker, byLane, byTruck, payment };
    },
  );
}
