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
  disconnectBoardCredential,
  encryptCredential,
  getBoardCredential,
  listBoardCredentials,
  listTrucks,
  scope,
  storeOAuthCredential,
  type Scope,
  type Truck,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { exchangeMotiveCode, motiveAuthorizeUrl } from '../integrations/motive.ts';
import { suggestMotiveMatches } from '../integrations/motive-match.ts';
import { accessTokenFor, fetchMotiveVehicles } from '../integrations/motive-sync.ts';
import { signOAuthState, verifyOAuthState } from '../integrations/state.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

/**
 * The whole fleet, not one page — Motive matching has to check every truck
 * against every Motive vehicle, and `listTrucks` is cursor-paginated now
 * (see `packages/db/src/pagination.ts`). A fleet large enough to span
 * multiple pages is exactly the case this walk exists for.
 */
async function listAllTrucks(s: Scope): Promise<Truck[]> {
  const all: Truck[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listTrucks(s, cursor ? { cursor } : {});
    all.push(...page.items);
    if (!page.nextCursor) return all;
    cursor = page.nextCursor;
  }
}

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

/** The callback above only ever seals a token, so it only needs the public
 *  half. Opening one back up — reading a stored Motive credential to call
 *  the API on a carrier's behalf — needs both. */
function requireDecryptionConfig(app: FastifyInstance) {
  const { CREDENTIAL_ENCRYPTION_PUBLIC_KEY, CREDENTIAL_ENCRYPTION_PRIVATE_KEY } = app.env;
  if (!CREDENTIAL_ENCRYPTION_PUBLIC_KEY || !CREDENTIAL_ENCRYPTION_PRIVATE_KEY) {
    throw new HttpError(
      503,
      'not_configured',
      'Credential encryption is not configured on this deployment yet.',
    );
  }
  return { publicKey: CREDENTIAL_ENCRYPTION_PUBLIC_KEY, privateKey: CREDENTIAL_ENCRYPTION_PRIVATE_KEY };
}

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/v1/integrations', async (request) => {
    const s = await requireScope(request);
    return { items: await listBoardCredentials(s) };
  });

  /**
   * Every Motive vehicle on this account, plus a best-effort suggested
   * match for each HaulQ truck that does not have one yet — see
   * `integrations/motive-match.ts` for how a suggestion is decided and why
   * it is only ever a suggestion. The web app turns a confirmed suggestion
   * into the same `PATCH /v1/trucks/:id/motive-vehicle` call a manual pick
   * already makes; there is no separate "confirm" endpoint because there is
   * nothing about accepting a suggestion that differs from picking by hand.
   */
  app.get('/v1/integrations/motive/vehicles', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');

    const credential = await getBoardCredential(s, 'motive');
    if (!credential || credential.status !== 'active') {
      throw new HttpError(
        409,
        'not_connected',
        'Connect Motive before matching trucks to vehicles.',
      );
    }

    const config = requireMotiveConfig(app);
    const { publicKey, privateKey } = requireDecryptionConfig(app);

    const [accessToken, trucks] = await Promise.all([
      accessTokenFor(
        { db: app.db, config, publicKey, privateKey, log: app.log },
        credential,
      ),
      listAllTrucks(s),
    ]);

    const vehicles = await fetchMotiveVehicles(accessToken);
    const suggestions = suggestMotiveMatches(
      trucks.map((t) => ({ id: t.id, label: t.label, motiveVehicleId: t.motiveVehicleId })),
      vehicles.map((v) => ({ id: v.id, number: v.number })),
    );

    return { vehicles, suggestions };
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

    // Every exit from here on is a redirect back into the web app, never a
    // raw JSON response — the browser is mid-navigation on Motive's own
    // redirect, not making an API call something can render an error for.
    // A config check thrown outside this try (as `requireMotiveConfig` and
    // `requireEncryptionConfig` do everywhere else) would otherwise land the
    // user on a bare `{"code":"not_configured",...}` page with no way back.
    try {
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
      const notConfigured = err instanceof HttpError && err.code === 'not_configured';
      app.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'motive oauth callback failed',
      );
      return reply.redirect(
        `${webOrigin}/integrations?motive=${notConfigured ? 'not_configured' : 'error'}`,
      );
    }
  });

  /**
   * Disconnect, deliberately separate from `connect` rather than a PATCH
   * toggling status — a carrier revoking access should be as unambiguous an
   * action as the connect button was, and DELETE reads as final in a way a
   * status flag does not.
   */
  app.delete('/v1/integrations/motive', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner');
    await disconnectBoardCredential(s, 'motive');
    return { ok: true };
  });
}
