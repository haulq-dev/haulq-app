/**
 * Push notification devices and preferences. MOBILE_PARITY_PLAN.md section 7.
 *
 * Per person, not per carrier, like `GET /v1/orgs`: a phone belongs to a
 * login, and that login may act in several carriers. So these authenticate
 * the user only, with no org header needed, except the test send, which
 * says which carrier it's from.
 *
 * - `POST /v1/push/devices` runs on every launch: registers or refreshes.
 * - `DELETE /v1/push/devices/:token` runs on sign-out. It has to, or the
 *   next person to sign in on a shared cab phone gets the last one's alerts.
 * - Preferences are the categories switched off; everything else is on.
 */

import { PushPreferencesSchema, RegisterPushDeviceSchema } from '@haulq/contracts';
import { getPushPreferences, pushTargets, registerPushDevice, setPushPreferences, unregisterPushDevice } from '@haulq/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, requireScope } from '../plugins/request-context.ts';
import { PushError } from '../push/sender.ts';

const TokenParamSchema = z.object({ token: z.string().min(8).max(4096) });

export async function pushRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  async function userId(request: FastifyRequest): Promise<string> {
    const authed = await app.authenticator.authenticateUser(request.headers);
    if (!authed) throw new HttpError(401, 'unauthenticated', 'Sign in to manage notifications.');
    return authed.actor.id;
  }

  server.post(
    '/v1/push/devices',
    { schema: { tags: ['Push'], summary: 'Register this phone for notifications', body: RegisterPushDeviceSchema } },
    async (request, reply) => {
      const id = await userId(request);
      await registerPushDevice(app.db, { userId: id, ...request.body });
      return reply.code(204).send();
    },
  );

  server.delete(
    '/v1/push/devices/:token',
    { schema: { tags: ['Push'], summary: 'Stop notifications to this phone (sign-out)', params: TokenParamSchema } },
    async (request, reply) => {
      const id = await userId(request);
      // 204 either way: signing out twice, or after the token moved to
      // someone else, is not an error the app can do anything about.
      await unregisterPushDevice(app.db, id, request.params.token);
      return reply.code(204).send();
    },
  );

  server.get(
    '/v1/push/preferences',
    { schema: { tags: ['Push'], summary: 'Which notifications are switched off' } },
    async (request) => getPushPreferences(app.db, await userId(request)),
  );

  server.put(
    '/v1/push/preferences',
    { schema: { tags: ['Push'], summary: 'Switch notifications on or off', body: PushPreferencesSchema } },
    async (request) => setPushPreferences(app.db, await userId(request), request.body.muted),
  );

  /**
   * Send the caller's own phones a notification, to check they work. What a
   * person reaches for when alerts don't seem to arrive, and how the first
   * device build proves the whole chain (key, entitlement, token) end to end.
   * Rate limited: it's a real APNs call.
   */
  server.post(
    '/v1/push/test',
    {
      schema: { tags: ['Push'], summary: "Send a test notification to the caller's phones" },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request) => {
      const s = await requireScope(request);
      const sender = app.pushSender;
      if (!sender) throw new HttpError(503, 'not_configured', "Notifications aren't set up on HaulQ's side yet.");
      if (s.ctx.actor.type !== 'user') throw new HttpError(403, 'forbidden', 'Only a person can test their own phone.');

      const devices = (await pushTargets(app.db, [s.ctx.actor.id], '')).filter((d) => sender.platforms.includes(d.platform));
      if (devices.length === 0) {
        throw new HttpError(409, 'no_devices', 'This phone isn’t registered for notifications. Turn them on in the app first.');
      }

      let sent = 0;
      for (const device of devices) {
        try {
          const outcome = await sender.send(
            { token: device.token, platform: device.platform },
            {
              title: 'HaulQ',
              body: 'Notifications are working on this phone.',
              path: '/notifications',
              orgId: s.ctx.orgId,
              collapseId: `test-${device.id}`,
            },
          );
          if (outcome === 'sent') sent += 1;
        } catch (err) {
          request.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'test push failed');
          if (!(err instanceof PushError)) throw err;
        }
      }
      if (sent === 0) throw new HttpError(502, 'push_failed', 'Apple didn’t accept the test notification. Try again in a minute.');
      return { sent };
    },
  );
}
