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
  issueCheckinLink,
  issueVisibilityLink,
  previewCheckin,
  previewTracking,
  recordCheckinPosition,
  recordStopCheckin,
  revokeCheckinLink,
  revokeVisibilityLink,
  TrackError,
} from '@haulq/db';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

const STATUS: Record<string, number> = {
  not_found: 404,
  driver_not_found: 404,
  invalid_token: 404,
  revoked: 410,
  expired: 410,
  no_truck: 422,
};

function rethrow(err: unknown): never {
  if (err instanceof TrackError) {
    throw new HttpError(STATUS[err.code] ?? 400, err.code, err.explanation);
  }
  throw err;
}

function badRequest(issues: { path: (string | number)[]; message: string }[]): never {
  throw new HttpError(
    400,
    'invalid_request',
    issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
  );
}

export async function trackRoutes(app: FastifyInstance) {
  // --- inside a tenant -----------------------------------------------------

  app.post('/v1/loads/:id/checkin-links', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = IssueCheckinLinkSchema.safeParse(request.body ?? {});
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      const result = await issueCheckinLink(s, id, parsed.data);
      // Returned once and never again — only the hash is stored.
      return reply.code(201).send({ link: result.link, token: result.token });
    } catch (err) {
      rethrow(err);
    }
  });

  app.delete('/v1/loads/:id/checkin-links', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    try {
      await revokeCheckinLink(s, id);
      return reply.code(204).send();
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/loads/:id/visibility-links', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    try {
      const result = await issueVisibilityLink(s, id);
      return reply.code(201).send({ link: result.link, token: result.token });
    } catch (err) {
      rethrow(err);
    }
  });

  app.delete('/v1/loads/:id/visibility-links', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    try {
      await revokeVisibilityLink(s, id);
      return reply.code(204).send();
    } catch (err) {
      rethrow(err);
    }
  });

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
  const publicTrackRouteLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  /** What a driver sees before tapping anything. */
  app.get('/v1/checkin/:token', publicTrackRouteLimit, async (request) => {
    const { token } = request.params as { token: string };
    try {
      return await previewCheckin(app.db, token);
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/checkin/:token/stops/:stopId', publicTrackRouteLimit, async (request) => {
    const { token, stopId } = request.params as { token: string; stopId: string };

    const parsed = RecordStopCheckinSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await recordStopCheckin(app.db, {
        token,
        stopId,
        milestone: parsed.data.milestone,
        occurredAt: parsed.data.occurredAt,
        correlationId: randomUUID(),
      });
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/checkin/:token/position', publicTrackRouteLimit, async (request, reply) => {
    const { token } = request.params as { token: string };

    const parsed = RecordPositionSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      await recordCheckinPosition(app.db, {
        token,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        recordedAt: parsed.data.recordedAt,
      });
      return reply.code(204).send();
    } catch (err) {
      rethrow(err);
    }
  });

  /**
   * A broker's read-only tracking page. Unauthenticated on purpose — the
   * link itself is what a broker was handed, and nothing here discloses
   * more than status, stop timestamps and the truck's last known position.
   * No ETA, no detention badge — see `repositories/track.ts`'s module note.
   */
  app.get('/v1/track/:token', publicTrackRouteLimit, async (request) => {
    const { token } = request.params as { token: string };
    try {
      return await previewTracking(app.db, token);
    } catch (err) {
      rethrow(err);
    }
  });
}
