/**
 * HaulQ Routes — nearby stops (truck stops, weigh stations, rest areas,
 * fuel) near each of a load's stops.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 4: the POI gap `PHASE_3_PLAN.md`
 * section 2 already named, filled by wiring HERE's `/browse` into a vendor
 * relationship this codebase already has rather than adding a new one —
 * see `here-places.ts`'s module note. No persistent state, same "computed
 * on demand, not stored" shape `feasibility.ts` already uses for 3a — this
 * is informational, not a go/no-go decision, so it writes nothing and
 * records no event.
 *
 * Gated the same way `feasibility.ts` and `geocode.ts` gate HERE: no
 * configured provider is a 503, not a 500 and not a silently-wrong answer.
 *
 * One deliberate difference from `feasibility.ts`: a stop with no
 * coordinates yet returns an empty `places` array for that stop rather than
 * failing the whole request. `feasibility()` has to refuse a guess because
 * its answer is a go/no-go decision; this endpoint's answer is "here is
 * what's nearby," and failing every stop because one of several has not
 * been geocoded yet is a worse outcome than showing what is actually known.
 */

import type { NearbyStopsResponse } from '@haulq/contracts';
import { getLoad } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireEntitlement } from '../billing/entitlements.ts';
import { HereApiError } from '../integrations/here.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

const IdParamSchema = z.object({ id: z.string().uuid() });

const METERS_PER_MILE = 1609.344;
/** How far a dispatcher can widen the search — beyond this it stops being "near this stop." */
const MAX_RADIUS_MILES = 50;

const QuerySchema = z.object({
  radiusMiles: z.coerce.number().positive().max(MAX_RADIUS_MILES).default(10),
});

export async function nearbyStopsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/loads/:id/nearby-stops',
    {
      schema: {
        tags: ['Loads'],
        summary: "Truck stops, weigh stations, rest areas and fuel near a load's stops",
        params: IdParamSchema,
        querystring: QuerySchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      // Same product as `feasibility.ts` — Routes is Fleet-only, see
      // `billing/entitlements.ts`. That gate landed after this route was
      // first written; added here to match rather than leave a second,
      // ungated door into the same product.
      await requireEntitlement(s, 'routes');
      const { id } = request.params;
      const { radiusMiles } = request.query;

      if (!app.placesProvider) {
        throw new HttpError(
          503,
          'not_configured',
          'HERE is not configured on this deployment yet — nearby-stop lookup is unavailable.',
        );
      }

      const load = await getLoad(s, id);
      if (!load) {
        throw new HttpError(404, 'not_found', 'That load no longer exists.');
      }

      const stops = [...load.stops].sort((a, b) => a.seq - b.seq);
      const radiusMeters = radiusMiles * METERS_PER_MILE;
      const provider = app.placesProvider;

      try {
        const results = await Promise.all(
          stops.map(async (stop) => ({
            seq: stop.seq,
            city: stop.city,
            state: stop.state,
            places:
              stop.lat === null || stop.lng === null
                ? []
                : await provider.nearbyStops(stop.lat, stop.lng, radiusMeters),
          })),
        );

        const response: NearbyStopsResponse = { stops: results };
        return response;
      } catch (err) {
        if (err instanceof HereApiError) {
          throw new HttpError(502, 'places_provider_error', 'HERE could not look up nearby stops right now.');
        }
        throw err;
      }
    },
  );
}
