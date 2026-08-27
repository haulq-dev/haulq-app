/**
 * HaulQ Routes — 3a, single-load feasibility.
 *
 * PHASE_3_PLAN.md section 6: 3a needs no persistent state — feasibility is
 * checked on demand and not stored, so this route reads `loads` and `trucks`
 * and writes nothing, the same "no table at all" the plan calls out
 * explicitly. No event recorded either, for the same reason `estimatedArrival`
 * in `repositories/track.ts` records none: this is a computed fact, not an
 * auditable action.
 *
 * Gated the same way `routes/integrations.ts` gates Motive: no configured
 * provider is a 503, not a 500 and not a silently-wrong answer. `apps/routing`
 * (module `../routing/feasibility.ts`) owns the pure verdict; this file is
 * the wiring — load a load, load a truck, call the provider, translate.
 */

import { CheckLoadFeasibilitySchema, type LoadFeasibilityResponse } from '@haulq/contracts';
import { getLoad, getTruck } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { HereApiError } from '../integrations/here.ts';
import type { TruckProfile } from '../integrations/routing-provider.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';
import { evaluateLoadFeasibility } from '../routing/feasibility.ts';

export async function feasibilityRoutes(app: FastifyInstance) {
  app.post('/v1/loads/:id/feasibility', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = CheckLoadFeasibilitySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }

    if (!app.routingProvider) {
      throw new HttpError(
        503,
        'not_configured',
        'HERE is not configured on this deployment yet — feasibility checks are unavailable.',
      );
    }

    const load = await getLoad(s, id);
    if (!load) {
      throw new HttpError(404, 'not_found', 'That load no longer exists.');
    }

    const truckId = parsed.data.truckId ?? load.truckId;
    if (!truckId) {
      throw new HttpError(
        409,
        'no_truck',
        'Assign a truck to this load, or pass truckId, before checking feasibility.',
      );
    }

    const truck = await getTruck(s, truckId);
    if (!truck) {
      throw new HttpError(404, 'truck_not_found', 'That truck is not on this account.');
    }

    const stops = [...load.stops].sort((a, b) => a.seq - b.seq);
    const missingCoordinates = stops.find((stop) => stop.lat === null || stop.lng === null);
    if (missingCoordinates) {
      throw new HttpError(
        422,
        'missing_coordinates',
        `Stop ${missingCoordinates.seq} (${missingCoordinates.city}, ${missingCoordinates.state}) has no coordinates, so a route cannot be requested yet.`,
      );
    }

    const routeStops = stops.map((stop) => ({ lat: stop.lat!, lng: stop.lng! }));
    const truckProfile: TruckProfile = {
      maxWeightLbs: truck.maxWeightLbs,
      maxLengthFt: truck.maxLengthFt,
      boxHeightIn: truck.boxHeightIn,
      boxWidthIn: truck.boxWidthIn,
      hazmat: load.hazmat,
    };

    try {
      const route = await app.routingProvider.route(routeStops, truckProfile, { departAt: new Date() });
      const restrictions = await app.routingProvider.feasibility(route, truckProfile);
      const verdict = evaluateLoadFeasibility(
        route,
        restrictions,
        stops.map((stop) => ({ seq: stop.seq, windowEnd: stop.windowEnd })),
      );

      const response: LoadFeasibilityResponse = {
        feasible: verdict.feasible,
        hoursChecked: false,
        decidingConstraint: verdict.decidingConstraint,
        routeMiles: verdict.routeMiles,
        estimatedArrivalAt: verdict.estimatedArrivalAt.toISOString(),
      };
      return response;
    } catch (err) {
      if (err instanceof HereApiError) {
        throw new HttpError(502, 'routing_provider_error', 'HERE could not compute a route for this load right now.');
      }
      throw err;
    }
  });
}
