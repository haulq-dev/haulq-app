/**
 * Nearby mechanics — a live Yelp search, not a trust score.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 3: the boss's own hedge on the call —
 * "could just be a normal AI search" — over building a persistent
 * aggregated-reviews pipeline. This is deliberately the small version: call
 * Yelp at request time, return what it says, store nothing. Cheap enough on
 * Yelp's free tier to find out whether carriers reach for this before any
 * scoring infrastructure gets built. See `yelp.ts`'s module note.
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
});

export async function mechanicsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

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
      await requireScope(request);
      const { lat, lng, radiusMiles, query } = request.query;

      if (!app.mechanicSearchProvider) {
        throw new HttpError(
          503,
          'not_configured',
          'Yelp is not configured on this deployment yet — nearby-mechanic search is unavailable.',
        );
      }

      try {
        const mechanics = await app.mechanicSearchProvider.nearbyMechanics(
          lat,
          lng,
          radiusMiles * METERS_PER_MILE,
          query,
        );
        const response: NearbyMechanicsResponse = { mechanics };
        return response;
      } catch (err) {
        if (err instanceof YelpApiError) {
          throw new HttpError(502, 'mechanic_search_provider_error', 'Yelp could not be reached right now.');
        }
        throw err;
      }
    },
  );
}
