/**
 * Connecting external boards and ELDs.
 *
 * One connection today — Motive — but the shape is meant to generalize:
 * `GET /v1/integrations` lists what is connected regardless of provider,
 * and each provider gets its own connect/callback pair rather than one
 * route branching on a `provider` param, the same reasoning
 * `documentRoutes`/`postmarkInboundRoutes` stay separate registrations
 * rather than one router guessing content type.
 *
 * `connect` returns a URL rather than redirecting directly, because the
 * browser navigating straight to an authenticated route carries none of the
 * headers `requireScope` needs — no cookie, no bearer token on a raw GET
 * navigation. The web app fetches the URL with its normal authenticated
 * client, then does the navigation itself.
 *
 * `callback` is the one unauthenticated route in this file — Motive's
 * redirect carries no HaulQ session, only the signed `state` this route
 * verifies. See `integrations/state.ts` for why that is safe.
 */

import { randomUUID } from 'node:crypto';
import {
  encryptCredential,
  listBoardCredentials,
  scope,
  storeOAuthCredential,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { exchangeMotiveCode, motiveAuthorizeUrl } from '../integrations/motive.ts';
import { signOAuthState, verifyOAuthState } from '../integrations/state.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

function requireMotiveConfig(app: FastifyInstance) {
  const { MOTIVE_CLIENT_ID, MOTIVE_CLIENT_SECRET, MOTIVE_REDIRECT_URI } = app.env;
  if (!MOTIVE_CLIENT_ID || !MOTIVE_CLIENT_SECRET || !MOTIVE_REDIRECT_URI) {
    throw new HttpError(
      503,
      'not_configured',
      'Motive is not configured on this deployment yet.',
    );
  }
  return { clientId: MOTIVE_CLIENT_ID, clientSecret: MOTIVE_CLIENT_SECRET, redirectUri: MOTIVE_REDIRECT_URI };
}

function requireEncryptionConfig(app: FastifyInstance) {
  const { CREDENTIAL_ENCRYPTION_PUBLIC_KEY } = app.env;
  if (!CREDENTIAL_ENCRYPTION_PUBLIC_KEY) {
    throw new HttpError(
      503,
      'not_configured',
      'Credential encryption is not configured on this deployment yet.',
    );
  }
  return CREDENTIAL_ENCRYPTION_PUBLIC_KEY;
}

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/v1/integrations', async (request) => {
    const s = await requireScope(request);
    return { items: await listBoardCredentials(s) };
  });

  /**
   * Returns the authorize URL; does not redirect. See the module note.
   */
  app.get('/v1/integrations/motive/connect', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner');

    const config = requireMotiveConfig(app);
    // The client secret signs state rather than a dedicated secret existing
    // just for this — both stay server-side, and adding a second secret to
    // configure for one HMAC buys nothing.
    const state = signOAuthState(config.clientSecret, s.ctx.orgId);
    return { url: motiveAuthorizeUrl(config, state) };
  });

  app.get('/v1/integrations/motive/callback', async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string };
    const webOrigin = app.env.WEB_ORIGIN.replace(/\/$/, '');

    if (q.error) {
      return reply.redirect(`${webOrigin}/integrations?motive=denied`);
    }

    const config = requireMotiveConfig(app);

    if (!q.code || !q.state) {
      throw new HttpError(400, 'invalid_request', 'Motive did not send a code and state.');
    }

    const orgId = verifyOAuthState(config.clientSecret, q.state);
    if (!orgId) {
      throw new HttpError(400, 'invalid_state', 'That connection request could not be verified.');
    }

    const publicKey = requireEncryptionConfig(app);

    try {
      const tokens = await exchangeMotiveCode(config, q.code);
      const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
        encryptCredential(publicKey, tokens.accessToken),
        encryptCredential(publicKey, tokens.refreshToken),
      ]);

      const s = scope(app.db, {
        orgId,
        // No person is at the keyboard for this request — Motive's server
        // redirected the browser here. Same actor family
        // `postmark-inbound.ts` uses for an external caller authenticating
        // by possessing a secret rather than by signing in.
        actor: { type: 'integration', provider: 'motive-oauth' },
        correlationId: randomUUID(),
      });

      await storeOAuthCredential(s, {
        board: 'motive',
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt: tokens.expiresAt,
      });

      return reply.redirect(`${webOrigin}/integrations?motive=connected`);
    } catch (err) {
      app.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'motive oauth callback failed',
      );
      return reply.redirect(`${webOrigin}/integrations?motive=error`);
    }
  });
}
