/**
 * Address lookup — turns a typed address into coordinates for a load stop.
 *
 * Gated the same way `feasibility.ts` gates HERE Routes: no configured
 * geocoder is a 503, not a 500 and not a silently-wrong answer. Returns
 * candidates rather than writing anything — the dispatcher picks one on the
 * stop form and it is saved through the normal create/update-stop path, same
 * "confirm before it's true" shape every other correction in this app takes.
 */

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HereApiError } from '../integrations/here.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

const GeocodeQuerySchema = z
  .object({
    addressLine1: z.string().max(200).optional(),
    city: z.string().min(1).max(100).optional(),
    state: z.string().length(2).optional(),
    postalCode: z.string().max(12).optional(),
  })
  .superRefine((input, ctx) => {
    // The one pair `StopBase` itself already requires — nothing a stop could
    // legally have would fail this.
    if (!input.city || !input.state) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Send at least a city and state.' });
    }
  });

export async function geocodeRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/geocode',
    {
      schema: {
        tags: ['Geocode'],
        summary: 'Look up coordinates for an address',
        querystring: GeocodeQuerySchema,
      },
    },
    async (request) => {
      await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');

      if (!app.geocoder) {
        throw new HttpError(
          503,
          'not_configured',
          'HERE is not configured on this deployment yet — address lookup is unavailable.',
        );
      }

      const { addressLine1, city, state, postalCode } = request.query;
      const query = [addressLine1, city, state, postalCode].filter(Boolean).join(', ');

      try {
        const candidates = await app.geocoder.geocode(query);
        return { candidates };
      } catch (err) {
        if (err instanceof HereApiError) {
          throw new HttpError(502, 'geocode_provider_error', 'HERE could not look up that address right now.');
        }
        throw err;
      }
    },
  );
}
