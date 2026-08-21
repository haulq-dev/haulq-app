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
import { HttpError, requireScope } from '../plugins/request-context.ts';

export async function insightsRoutes(app: FastifyInstance) {
  app.get('/v1/insights', async (request) => {
    const s = await requireScope(request);
    const q = request.query as { days?: string };

    const days = q.days ? Number(q.days) : 90;
    if (!Number.isFinite(days) || days < 1 || days > 730) {
      throw new HttpError(
        400,
        'invalid_request',
        'The window must be between 1 and 730 days.',
      );
    }

    const [summary, byBroker, byLane, byTruck, payment] = await Promise.all([
      insightsSummary(s, { days }),
      revenueByBroker(s, { days }),
      revenueByLane(s, { days }),
      revenueByTruck(s, { days }),
      paymentPerformance(s, { days }),
    ]);

    return { summary, byBroker, byLane, byTruck, payment };
  });
}
