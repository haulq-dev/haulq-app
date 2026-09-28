/**
 * Mailbox connect / status / disconnect.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 1: connect a carrier's actual work
 * inbox through Unipile's hosted auth wizard so a rate confirmation reaches
 * HaulQ's existing Docs pipeline the moment a broker sends it — see
 * `unipile.ts`'s module note for the full reasoning and `unipile-inbound.ts`
 * for where a connected mailbox's mail actually lands.
 *
 * `connect` returns the hosted-auth URL; it does not redirect — same shape
 * `integrations.ts`'s Motive `connect` route already uses, for the same
 * reason: this is an API a frontend calls before sending the browser
 * anywhere, not the browser's own navigation target.
 *
 * Nothing in this file sends mail. Connecting a mailbox only enables
 * *reading* it. Sending through a connected mailbox is a separate,
 * opt-in capability (`sending_enabled`, off by default and reset on every
 * reconnect) that goes only through `outbound/dispatch.ts` — see
 * `FEATURE_REQUESTS_PLAN.md` section 8 for why it is gated that way.
 */

import { disconnectMailbox, getMailboxConnection, requestMailboxConnection } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { UnipileApiError } from '../integrations/unipile.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';
import { appReturnPath } from './app-return.ts';

function unipileConfigured(app: FastifyInstance): boolean {
  return Boolean(app.unipileClient) && Boolean(app.env.UNIPILE_NOTIFY_URL);
}

function requireUnipileConfig(app: FastifyInstance): { notifyUrl: string } {
  if (!unipileConfigured(app)) {
    throw new HttpError(
      503,
      'not_configured',
      'Mailbox connect is not configured on this deployment yet.',
    );
  }
  return { notifyUrl: app.env.UNIPILE_NOTIFY_URL! };
}

/** `?client=app` when the mobile app starts the connect; see `app-return.ts`. */
const ConnectQuerySchema = z.object({
  client: z.enum(['web', 'app']).optional(),
});

export async function mailboxRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/mailbox',
    { schema: { tags: ['Mailbox'], summary: 'This org\'s mailbox connection status' } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const connection = await getMailboxConnection(s);
      return {
        connected: connection?.status === 'connected',
        status: connection?.status ?? 'not_connected',
        provider: connection?.provider ?? null,
        connectedAt: connection?.connectedAt?.toISOString() ?? null,
        // Whether this deployment can even attempt a connect — Postmark
        // forwarding (InboundEmailPanel in Documents.tsx) is the default way
        // rate confirmations arrive; this is a work-in-progress alternative
        // that also lets Autopilot send from the carrier's own mailbox.
        configured: unipileConfigured(app),
      };
    },
  );

  server.post(
    '/v1/mailbox/connect',
    { schema: { tags: ['Mailbox'], summary: 'Start connecting a mailbox', querystring: ConnectQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner');
      const { notifyUrl } = requireUnipileConfig(app);
      // Started from the app: finish on this API's hand-back page, which
      // opens the app again, instead of a web page the in-app browser isn't
      // signed in to. The notify URL is this API's own public address (see
      // its note in env.ts), so its origin is where that page lives.
      const fromApp = request.query.client === 'app';
      const apiOrigin = new URL(notifyUrl).origin;

      await requestMailboxConnection(s);

      const webOrigin = app.env.WEB_ORIGIN.replace(/\/$/, '');
      try {
        const url = await app.unipileClient!.createHostedAuthLink({
          // HaulQ's own org id, not a signed state — Unipile echoes `name`
          // back verbatim on `notify_url`, which is what lets
          // `account-notify` resolve this callback to a tenant with no
          // state-signing of HaulQ's own. See `unipile.ts`'s module note.
          name: s.ctx.orgId,
          notifyUrl,
          successRedirectUrl: fromApp
            ? `${apiOrigin}${appReturnPath({ mailbox: 'connected' })}`
            : `${webOrigin}/autopilot?mailbox=connected`,
          failureRedirectUrl: fromApp
            ? `${apiOrigin}${appReturnPath({ mailbox: 'denied' })}`
            : `${webOrigin}/autopilot?mailbox=denied`,
        });
        return { url };
      } catch (err) {
        if (err instanceof UnipileApiError) {
          throw new HttpError(502, 'mailbox_provider_error', 'Unipile could not start a connection right now.');
        }
        throw err;
      }
    },
  );

  /**
   * Deliberately separate from `connect` rather than a PATCH toggling
   * status — same reasoning `integrations.ts`'s Motive disconnect route
   * gives: a carrier revoking access should be as unambiguous an action as
   * the connect button was.
   */
  server.delete(
    '/v1/mailbox',
    { schema: { tags: ['Mailbox'], summary: 'Disconnect the mailbox' } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner');
      await disconnectMailbox(s);
      return reply.code(204).send();
    },
  );
}
