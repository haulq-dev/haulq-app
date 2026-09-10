/**
 * Track — Phase 2a.
 *
 * PHASE_2_PLAN.md section 4. Two families of route, same split `members.ts`
 * already uses:
 *
 *  - **Inside a tenant** — issuing and revoking links. Owner or dispatcher,
 *    same as everything else that changes a load.
 *  - **Without a tenant** — a driver's check-in and a broker's tracking
 *    page. The token is the authority; see `repositories/track.ts`'s
 *    module note for why a driver check-in write records as an
 *    `integration` actor rather than a `user`.
 *
 * No driver-facing or broker-facing UI is decided or built against these
 * yet beyond the broker's own tracking page (`Track.tsx`) — see
 * PHASE_2_PLAN.md section 4's open question on native vs. web for the
 * driver surface. These routes are what either answer will call.
 */

import {
  IssueCheckinLinkSchema,
  RecordPositionSchema,
  RecordStopCheckinSchema,
} from '@haulq/contracts';
import {
  getLoad,
  issueCheckinLink,
  issueVisibilityLink,
  previewCheckin,
  previewTracking,
  recordCheckinPosition,
  recordStopCheckin,
  recordStopCheckinAsDriver,
  recordTruckPosition,
  revokeCheckinLink,
  revokeVisibilityLink,
  TrackError,
  undoStopCheckin,
  undoStopCheckinAsDriver,
} from '@haulq/db';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';
import { driverScopeFor } from './loads.ts';

const STATUS: Record<string, number> = {
  not_found: 404,
  driver_not_found: 404,
  invalid_token: 404,
  revoked: 410,
  expired: 410,
  no_truck: 422,
  not_set: 422,
  undo_window_passed: 422,
};

function rethrow(err: unknown): never {
  if (err instanceof TrackError) {
    throw new HttpError(STATUS[err.code] ?? 400, err.code, err.explanation);
  }
  throw err;
}

const IdParamSchema = z.object({ id: z.string().uuid() });
// Not `.uuid()` — a checkin token is deliberately an 8-character code a
// driver can read aloud, and a visibility token is a different, full-entropy
// opaque string. Neither is a UUID; see the module note on `checkin/:token`.
const TokenParamSchema = z.object({ token: z.string().min(1) });
const StopCheckinParamSchema = z.object({ token: z.string().min(1), stopId: z.string().uuid() });
const AuthedStopParamSchema = z.object({ id: z.string().uuid(), stopId: z.string().uuid() });

export async function trackRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // --- inside a tenant -----------------------------------------------------

  server.post(
    '/v1/loads/:id/checkin-links',
    {
      schema: {
        tags: ['Track'],
        summary: 'Issue a driver check-in link for a load',
        params: IdParamSchema,
        // `.nullish()`, not `.optional()` — every field on
        // IssueCheckinLinkSchema has a default, so a bare POST with no body
        // is the common case, but Fastify's own JSON body parser hands an
        // empty body through as `null`, not `undefined`. `.optional()` only
        // widens to accept the latter, so the actual common case was
        // rejected by the schema before the handler's `request.body ?? {}`
        // ever ran.
        body: IssueCheckinLinkSchema.nullish(),
      },
    },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;

      try {
        const result = await issueCheckinLink(s, id, request.body ?? {});
        // Returned once and never again — only the hash is stored.
        return reply.code(201).send({ link: result.link, token: result.token });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.delete(
    '/v1/loads/:id/checkin-links',
    { schema: { tags: ['Track'], summary: 'Revoke a check-in link', params: IdParamSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;

      try {
        await revokeCheckinLink(s, id);
        return reply.code(204).send();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/loads/:id/visibility-links',
    { schema: { tags: ['Track'], summary: "Issue a broker's tracking link", params: IdParamSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;

      try {
        const result = await issueVisibilityLink(s, id);
        return reply.code(201).send({ link: result.link, token: result.token });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.delete(
    '/v1/loads/:id/visibility-links',
    { schema: { tags: ['Track'], summary: 'Revoke a tracking link', params: IdParamSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;

      try {
        await revokeVisibilityLink(s, id);
        return reply.code(204).send();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /**
   * A signed-in driver's own milestone report — the account-based
   * counterpart to `POST /v1/checkin/:token/stops/:stopId` below. Same
   * write (`applyStopCheckin` in `repositories/track.ts`), reached through
   * `requireScope`/`requireRole` instead of a token, so `load_stop.checkin`
   * records the actual driver as the actor rather than
   * `driver_checkin_link`. See that repository's module note for why both
   * paths stay live side by side.
   */
  server.post(
    '/v1/loads/:id/stops/:stopId/checkin',
    {
      schema: {
        tags: ['Track'],
        summary: "A signed-in driver's own stop milestone",
        params: AuthedStopParamSchema,
        body: RecordStopCheckinSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'driver');
      const { id, stopId } = request.params;

      const load = await getLoad(s, id);
      if (!load) throw new HttpError(404, 'not_found', 'That load no longer exists.');
      const driverScope = await driverScopeFor(s, request);
      if (driverScope !== undefined && load.driverId !== driverScope) {
        throw new HttpError(404, 'not_found', 'That load no longer exists.');
      }

      try {
        return await recordStopCheckinAsDriver(s, {
          loadId: id,
          stopId,
          milestone: request.body.milestone,
          occurredAt: request.body.occurredAt,
        });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/loads/:id/stops/:stopId/checkin/undo',
    {
      schema: {
        tags: ['Track'],
        summary: "Undo a signed-in driver's own mis-tapped milestone",
        params: AuthedStopParamSchema,
        body: RecordStopCheckinSchema.pick({ milestone: true }),
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'driver');
      const { id, stopId } = request.params;

      const load = await getLoad(s, id);
      if (!load) throw new HttpError(404, 'not_found', 'That load no longer exists.');
      const driverScope = await driverScopeFor(s, request);
      if (driverScope !== undefined && load.driverId !== driverScope) {
        throw new HttpError(404, 'not_found', 'That load no longer exists.');
      }

      try {
        return await undoStopCheckinAsDriver(s, { loadId: id, stopId, milestone: request.body.milestone });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /**
   * A signed-in driver's own position ping — the account-based counterpart
   * to `POST /v1/checkin/:token/position` below. `recordTruckPosition`
   * itself needs no actor (position is telemetry, not an audit event — see
   * its own doc), so this only has to resolve the load's truck and reuse it
   * directly, same as the anonymous route does.
   */
  server.post(
    '/v1/loads/:id/position',
    {
      schema: {
        tags: ['Track'],
        summary: "A signed-in driver's own position ping",
        params: IdParamSchema,
        body: RecordPositionSchema,
      },
    },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'driver');
      const { id } = request.params;
      const { lat, lng } = request.body;

      const load = await getLoad(s, id);
      if (!load) throw new HttpError(404, 'not_found', 'That load no longer exists.');
      const driverScope = await driverScopeFor(s, request);
      if (driverScope !== undefined && load.driverId !== driverScope) {
        throw new HttpError(404, 'not_found', 'That load no longer exists.');
      }
      if (!load.truckId) {
        throw new HttpError(
          422,
          'no_truck',
          'This load has no truck assigned yet, so there is nowhere to record a position.',
        );
      }

      let resolved: { city: string | null; state: string | null } | undefined;
      if (app.reverseGeocoder) {
        try {
          resolved = await app.reverseGeocoder.reverseGeocode(lat, lng);
        } catch (err) {
          request.log.warn({ err }, 'reverse geocode failed for a driver-app position ping');
        }
      }

      await recordTruckPosition(app.db, {
        orgId: s.ctx.orgId,
        truckId: load.truckId,
        lat,
        lng,
        recordedAt: request.body.recordedAt ? new Date(request.body.recordedAt) : new Date(),
        source: 'driver_app',
        ...(resolved ? { city: resolved.city, state: resolved.state } : {}),
      });
      return reply.code(204).send();
    },
  );

  // --- without a tenant ------------------------------------------------------

  /**
   * 30/minute per IP — generous for a real driver (a page load, a handful
   * of milestone taps, a position ping every five minutes) but a real wall
   * against guessing a token. It matters most here: `checkin/:token`'s
   * token is now an 8-character code chosen specifically so a driver can
   * read it aloud (`repositories/track.ts`'s `generateCheckinCode`), and
   * nothing on this API has ever throttled a request before this. Applied
   * to `/v1/track/:token` too — its own token stays full-entropy, but it is
   * the other route the CORS policy above just opened to any origin, and
   * `global: false` on the plugin means neither gets a limit for free.
   */
  const publicTrackRouteLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  /** What a driver sees before tapping anything. */
  server.get(
    '/v1/checkin/:token',
    {
      config: publicTrackRouteLimit,
      schema: { tags: ['Track'], summary: 'Preview a check-in link', params: TokenParamSchema },
    },
    async (request) => {
      const { token } = request.params;
      try {
        return await previewCheckin(app.db, token);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/checkin/:token/stops/:stopId',
    {
      config: publicTrackRouteLimit,
      schema: {
        tags: ['Track'],
        summary: 'Record a stop milestone',
        params: StopCheckinParamSchema,
        body: RecordStopCheckinSchema,
      },
    },
    async (request) => {
      const { token, stopId } = request.params;

      try {
        return await recordStopCheckin(app.db, {
          token,
          stopId,
          milestone: request.body.milestone,
          occurredAt: request.body.occurredAt,
          correlationId: randomUUID(),
        });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /**
   * Undoes a driver's own mis-tap — see `undoStopCheckin`'s own comment for
   * the window it enforces and why that enforcement lives server-side.
   */
  server.post(
    '/v1/checkin/:token/stops/:stopId/undo',
    {
      config: publicTrackRouteLimit,
      schema: {
        tags: ['Track'],
        summary: 'Undo a mis-tapped stop milestone, within the undo window',
        params: StopCheckinParamSchema,
        body: RecordStopCheckinSchema.pick({ milestone: true }),
      },
    },
    async (request) => {
      const { token, stopId } = request.params;

      try {
        return await undoStopCheckin(app.db, {
          token,
          stopId,
          milestone: request.body.milestone,
          correlationId: randomUUID(),
        });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/checkin/:token/position',
    {
      config: publicTrackRouteLimit,
      schema: {
        tags: ['Track'],
        summary: "Record the driver's position",
        params: TokenParamSchema,
        body: RecordPositionSchema,
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      const { lat, lng } = request.body;

      /**
       * Best-effort, and deliberately not inside the same try/catch as the
       * write below. A driver's position landing is the requirement; a
       * friendly city name on it is enrichment. Losing the second must
       * never lose the first — see `recordTruckPosition`'s own doc on why
       * an omitted (not attempted) lookup differs from one that resolved
       * to nothing.
       */
      let resolved: { city: string | null; state: string | null } | undefined;
      if (app.reverseGeocoder) {
        try {
          resolved = await app.reverseGeocoder.reverseGeocode(lat, lng);
        } catch (err) {
          request.log.warn({ err }, 'reverse geocode failed for a check-in position ping');
        }
      }

      try {
        await recordCheckinPosition(app.db, {
          token,
          lat,
          lng,
          recordedAt: request.body.recordedAt,
          ...(resolved ? { city: resolved.city, state: resolved.state } : {}),
        });
        return reply.code(204).send();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /**
   * A broker's read-only tracking page. Unauthenticated on purpose — the
   * link itself is what a broker was handed, and nothing here discloses
   * more than status, stop timestamps and the truck's last known position.
   * No ETA, no detention badge — see `repositories/track.ts`'s module note.
   */
  server.get(
    '/v1/track/:token',
    {
      config: publicTrackRouteLimit,
      schema: { tags: ['Track'], summary: "A broker's tracking page", params: TokenParamSchema },
    },
    async (request) => {
      const { token } = request.params;
      try {
        return await previewTracking(app.db, token);
      } catch (err) {
        rethrow(err);
      }
    },
  );
}
