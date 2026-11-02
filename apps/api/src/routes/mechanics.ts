/**
 * Nearby mechanics — a live HERE search, not a trust score.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 3: the boss's own hedge on the call —
 * "could just be a normal AI search" — over building a persistent
 * aggregated-reviews pipeline. This is deliberately the small version: call
 * HERE at request time, return what it says, store nothing. Each carrier is
 * capped (see `MECHANIC_SEARCH_ORG_DAILY_LIMIT`). Enough to find out whether
 * carriers reach for this before any scoring infrastructure gets built. See
 * `here-mechanics.ts`'s module note, including why this is not Yelp any more.
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

import type { Mechanic as MechanicResponse, NearbyMechanicsResponse } from '@haulq/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HereApiError } from '../integrations/here.ts';
import type { Mechanic } from '../integrations/here-mechanics.ts';
import { HttpError, requireScope } from '../plugins/request-context.ts';

const METERS_PER_MILE = 1609.344;
/** A shop farther than this is not "nearby" for a truck that has to get there. */
const MAX_RADIUS_MILES = 24;

const QuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusMiles: z.coerce.number().positive().max(MAX_RADIUS_MILES).default(15),
  /** Free-text, used when `categories` names no kind of business HERE has. Defaults to what a carrier almost always means. */
  query: z.string().min(1).max(100).default('diesel truck repair'),
  /**
   * The kinds of business to look for ("towing", "tires", "truckrepair"): see
   * `here-mechanics.ts`. Left out for free-text searches, where only the words
   * decide. Held to this shape so nothing else can ride along in the query string.
   */
  categories: z
    .string()
    .max(80)
    .regex(/^[a-z0-9_]+(,[a-z0-9_]+)*$/, 'Categories are comma-separated names.')
    .optional(),
});

/** The day, in UTC, which is when a carrier's count starts over. */
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The three fields Yelp's data needed, still sent because iOS builds already
 * installed read them: no rating shows as "Not rated on Yelp", and their "Reviews
 * on Yelp" link goes to `yelpUrl`, which is now an ordinary search on Yelp's public
 * site rather than a dead link. Nothing newer reads these. Drop them once those
 * builds are gone.
 */
function withInstalledAppFields(mechanic: Mechanic): MechanicResponse {
  const search = new URLSearchParams({ find_desc: mechanic.name, find_loc: mechanic.address ?? `${mechanic.lat},${mechanic.lng}` });
  return { ...mechanic, rating: null, reviewCount: 0, yelpUrl: `https://www.yelp.com/search?${search}` };
}

export async function mechanicsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Searches each carrier has run today. See `MECHANIC_SEARCH_ORG_DAILY_LIMIT` for why this
  // exists and why it lives in memory. Yesterday's counts are dropped as they
  // are seen, so the map cannot grow without bound.
  const searchesToday = new Map<string, { day: string; count: number }>();
  const spend = (orgId: string): boolean => {
    const today = utcDay(new Date());
    const seen = searchesToday.get(orgId);
    const count = seen && seen.day === today ? seen.count : 0;
    if (count >= app.env.MECHANIC_SEARCH_ORG_DAILY_LIMIT) return false;
    searchesToday.set(orgId, { day: today, count: count + 1 });
    for (const [id, s] of searchesToday) if (s.day !== today) searchesToday.delete(id);
    return true;
  };

  server.get(
    '/v1/mechanics/nearby',
    {
      schema: {
        tags: ['Mechanics'],
        summary: 'Nearby truck repair, tire and towing businesses, live from HERE',
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
          'HERE is not configured on this deployment yet — nearby-mechanic search is unavailable.',
        );
      }

      // Checked after "is it configured" so an unconfigured deployment does not
      // count searches it never made, and before the call, since the call is
      // the thing being rationed.
      if (!spend(s.ctx.orgId)) {
        throw new HttpError(
          429,
          'org_search_limit_reached',
          `Your carrier has used its ${app.env.MECHANIC_SEARCH_ORG_DAILY_LIMIT} repair-shop searches for today. The count starts over at midnight UTC (7 pm Central).`,
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
        const response: NearbyMechanicsResponse = { mechanics: mechanics.map(withInstalledAppFields) };
        return response;
      } catch (err) {
        // HERE is limiting the account's rate. Passes on its own, so it says so.
        if (err instanceof HereApiError && err.status === 429) {
          throw new HttpError(
            429,
            'search_limit_reached',
            'Repair-shop search is busy right now. Try again in a minute.',
          );
        }
        if (err instanceof HereApiError) {
          throw new HttpError(502, 'mechanic_search_provider_error', 'Repair-shop search could not be reached right now.');
        }
        throw err;
      }
    },
  );
}
