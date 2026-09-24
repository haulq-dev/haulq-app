/**
 * Nearby mechanics — a live Yelp search, not a trust score.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 3: the boss's own hedge on the call —
 * "could just be a normal AI search" — over building a persistent
 * aggregated-reviews pipeline. This is deliberately the small version: call
 * Yelp at request time, return what it says, store nothing. HaulQ's Yelp
 * account allows 300 calls a day in total, so each carrier is capped (see
 * `YELP_ORG_DAILY_LIMIT`); enough to find out whether carriers reach for this
 * before any scoring infrastructure gets built. See `yelp.ts`'s module note.
 *
 * Read-only and useful to anyone on the org, same reasoning `insights.ts`
 * gives for skipping a role gate beyond the tenant scope — a driver
 * broken down on the shoulder needs this at least as much as a dispatcher
 * does, and there is nothing here to protect a role gate would earn its
 * keep on. Not tied to a load or a plan tier — unlike Track and Routes,
 * this was never on the product ladder `PROJECT-STATUS.md` tracks, so
 * where it lands commercially is an open business decision, not
 * something to guess at in this file.
 */

import type { NearbyMechanicsResponse } from '@haulq/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { YelpApiError } from '../integrations/yelp.ts';
import { HttpError, requireScope } from '../plugins/request-context.ts';

const METERS_PER_MILE = 1609.344;
/** Yelp's own documented ceiling on `radius` (40,000 m) is the real limit — this just keeps the query meaningful before that. */
const MAX_RADIUS_MILES = 24;

const QuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusMiles: z.coerce.number().positive().max(MAX_RADIUS_MILES).default(15),
  /** Free-text, same as typing into Yelp's own search box. Defaults to what a carrier almost always means. */
  query: z.string().min(1).max(100).default('diesel truck repair'),
  /**
   * Yelp category aliases that narrow what counts as a match ("towing",
   * "tires", "truckrepair,autorepair"). Left out for free-text searches, where
   * only the words decide. Shaped like Yelp's own aliases so nothing else can
   * ride along in the query string.
   */
  categories: z
    .string()
    .max(80)
    .regex(/^[a-z0-9_]+(,[a-z0-9_]+)*$/, 'Categories are comma-separated Yelp category names.')
    .optional(),
});

/** The day, in UTC, which is when Yelp resets its own budget. */
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export async function mechanicsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Searches each carrier has run today. See `YELP_ORG_DAILY_LIMIT` for why this
  // exists and why it lives in memory. Yesterday's counts are dropped as they
  // are seen, so the map cannot grow without bound.
  const searchesToday = new Map<string, { day: string; count: number }>();
  const spend = (orgId: string): boolean => {
    const today = utcDay(new Date());
    const seen = searchesToday.get(orgId);
    const count = seen && seen.day === today ? seen.count : 0;
    if (count >= app.env.YELP_ORG_DAILY_LIMIT) return false;
    searchesToday.set(orgId, { day: today, count: count + 1 });
    for (const [id, s] of searchesToday) if (s.day !== today) searchesToday.delete(id);
    return true;
  };

  server.get(
    '/v1/mechanics/nearby',
    {
      schema: {
        tags: ['Mechanics'],
        summary: 'Nearby auto/truck repair shops, live from Yelp',
        querystring: QuerySchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      const { lat, lng, radiusMiles, query, categories } = request.query;

      if (!app.mechanicSearchProvider) {
        throw new HttpError(
          503,
          'not_configured',
          'Yelp is not configured on this deployment yet — nearby-mechanic search is unavailable.',
        );
      }

      // Checked after "is it configured" so an unconfigured deployment does not
      // count searches it never made, and before the call, since the call is
      // the thing being rationed.
      if (!spend(s.ctx.orgId)) {
        throw new HttpError(
          429,
          'org_search_limit_reached',
          `Your carrier has used its ${app.env.YELP_ORG_DAILY_LIMIT} repair-shop searches for today. The count starts over at midnight UTC (7 pm Central).`,
        );
      }

      try {
        const mechanics = await app.mechanicSearchProvider.nearbyMechanics(
          lat,
          lng,
          radiusMiles * METERS_PER_MILE,
          query,
          categories,
        );
        const response: NearbyMechanicsResponse = { mechanics };
        return response;
      } catch (err) {
        // Yelp's own daily budget (300, shared by every carrier) ran out.
        if (err instanceof YelpApiError && err.status === 429) {
          throw new HttpError(
            429,
            'search_limit_reached',
            "HaulQ's repair-shop search has reached its daily limit. It starts over at midnight UTC (7 pm Central). Until then, try a map search or call a shop directly.",
          );
        }
        if (err instanceof YelpApiError) {
          throw new HttpError(502, 'mechanic_search_provider_error', 'Yelp could not be reached right now.');
        }
        throw err;
      }
    },
  );
}
