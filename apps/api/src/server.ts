/**
 * The Fastify app.
 *
 * Built as a factory returning an unlistened instance so tests can drive it
 * with `app.inject()` and never bind a port.
 *
 * There are no business routes here yet, on purpose — this session scaffolds
 * Phase 0, it does not implement it. What exists is the shape every later route
 * plugs into: env validation, a database handle on the instance, CORS scoped to
 * the app origin, and a health check that actually checks something.
 */

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  closeDatabase,
  createDatabase,
  ping,
  R2ObjectStore,
  type Database,
  type ObjectStore,
} from '@haulq/db';
import type { Authenticator } from './auth/authenticator.ts';
import { ClerkAuthenticator } from './auth/clerk-authenticator.ts';
import { DevAuthenticator } from './auth/dev-authenticator.ts';
import type { Env } from './env.ts';
import type { Mailer } from './email/postmark.ts';
import { startExceptionScanRunner } from './exceptions/runner.ts';
import { startMotiveSyncRunner } from './integrations/motive-sync-runner.ts';
import { buildOutboxGroups } from './outbox/handlers.ts';
import { startOutboxRunner } from './outbox/runner.ts';
import { buildDocumentReader, buildMailer, buildModelReader, buildRoutingProvider, buildStorage } from './runtime.ts';
import type { ModelDocumentReader } from './documents/model-reader.ts';
import type { DocumentReader } from './documents/reader.ts';
import type { RoutingProvider } from './integrations/routing-provider.ts';
import { requestContextPlugin } from './plugins/request-context.ts';
import { brokerRoutes } from './routes/brokers.ts';
import { documentRoutes } from './routes/documents.ts';
import { feasibilityRoutes } from './routes/feasibility.ts';
import { integrationRoutes } from './routes/integrations.ts';
import { driverRoutes } from './routes/drivers.ts';
import { importRoutes } from './routes/imports.ts';
import { insightsRoutes } from './routes/insights.ts';
import { loadRoutes } from './routes/loads.ts';
import { memberRoutes } from './routes/members.ts';
import { orgRoutes } from './routes/orgs.ts';
import { payRoutes } from './routes/pay.ts';
import { postmarkInboundRoutes } from './routes/postmark-inbound.ts';
import { timelineRoutes } from './routes/timeline.ts';
import { trackRoutes } from './routes/track.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { truckRoutes } from './routes/trucks.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    env: Env;
    storage: ObjectStore;
    /** Undefined until `HERE_API_KEY` is set — see `runtime.ts`'s `buildRoutingProvider`. */
    routingProvider: RoutingProvider | undefined;
  }
}

export interface BuildOptions {
  /**
   * Override object storage. Tests inject an in-memory store. Left unset, the
   * server picks R2 when the `R2_*` variables are present and the local
   * filesystem when they are not — see `buildStorage`.
   */
  storage?: ObjectStore;

  /**
   * Override the authenticator. Tests inject a fake; production will inject
   * Clerk. Defaults to the dev stub, which refuses to construct outside
   * development.
   */
  authenticator?: Authenticator;

  /**
   * Override the mailer. Tests inject a recorder. Left unset, the server sends
   * through Postmark when a token is configured and logs when it is not.
   */
  mailer?: Mailer;

  /**
   * Override the document reader. Tests inject a fake. Left unset this is the
   * text-layer reader, which handles digital PDFs at no cost and declines
   * everything else — see `documents/reader.ts` for why that is the production
   * default and not a placeholder.
   */
  reader?: DocumentReader;

  /**
   * Override the model pass. Tests inject a fake or leave it unset. Left
   * unset in production this is Anthropic when `ANTHROPIC_API_KEY` is
   * configured, and no model pass at all when it is not — see
   * `documents/model-reader.ts`.
   */
  modelReader?: ModelDocumentReader | undefined;

  /**
   * Override the routing provider. Tests inject a fake so 3a's feasibility
   * route can be exercised end to end with no HERE account — see the note at
   * the top of `here.ts`. Left unset, the server picks HERE when
   * `HERE_API_KEY` is configured, and no provider at all when it is not.
   */
  routingProvider?: RoutingProvider | undefined;
}

/**
 * Pick an authenticator from configuration.
 *
 * The DevAuthenticator's own constructor refuses to run in production, so a
 * deployment that forgets to set AUTH_PROVIDER=clerk fails to boot rather than
 * serving header-trusting auth to the internet.
 */
function buildAuthenticator(env: Env, db: Database) {
  if (env.AUTH_PROVIDER === 'clerk') {
    if (!env.CLERK_SECRET_KEY) {
      throw new Error('AUTH_PROVIDER=clerk requires CLERK_SECRET_KEY.');
    }
    return new ClerkAuthenticator({ db, secretKey: env.CLERK_SECRET_KEY });
  }
  return new DevAuthenticator(env.NODE_ENV, db);
}

export async function buildServer(
  env: Env,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // Render terminates TLS upstream; without this every logged client IP is
    // the proxy's, which makes the event log's ip_address column useless.
    trustProxy: true,
    disableRequestLogging: env.NODE_ENV === 'production',
  });

  const db = createDatabase({
    url: env.DATABASE_URL,
    debug: env.NODE_ENV === 'development',
  });

  // Graceful shutdown. Fastify closing without draining the pool leaves
  // connections for Postgres to time out, which on a small instance is a real
  // ceiling — and in tests it hangs the runner on an open handle.
  app.addHook('onClose', async () => {
    await closeDatabase(db);
  });

  app.decorate('db', db);
  app.decorate('env', env);
  app.decorate(
    'authenticator',
    options.authenticator ?? buildAuthenticator(env, db),
  );
  const storage = options.storage ?? buildStorage(env, app.log);
  app.decorate('storage', storage);

  // R2 holds HTTP sockets open. Same reasoning as the database pool above: a
  // process that exits without releasing them leaves the runner hanging on an
  // open handle, which reads like a deadlock in whatever was under test.
  app.addHook('onClose', async () => {
    if (storage instanceof R2ObjectStore) storage.destroy();
  });

  const mailer = options.mailer ?? buildMailer(env, app.log);
  const reader = options.reader ?? buildDocumentReader(env, app.log);
  const modelReader = options.modelReader ?? buildModelReader(env, app.log);
  app.decorate('routingProvider', options.routingProvider ?? buildRoutingProvider(env, app.log));

  startOutboxRunner(app, {
    groups: buildOutboxGroups({
      mailer,
      webOrigin: env.WEB_ORIGIN,
      db,
      storage,
      reader,
      modelReader,
      log: {
        info: (o, msg) => app.log.info(o, msg),
        warn: (o, msg) => app.log.warn(o, msg),
      },
    }),
    intervalMs: env.OUTBOX_POLL_MS,
  });

  startExceptionScanRunner(app, {
    intervalMs: env.EXCEPTION_SCAN_POLL_MS,
    thresholdHours: env.EXCEPTION_THRESHOLD_HOURS,
  });

  // Same guard `routes/integrations.ts`'s `requireMotiveConfig`/
  // `requireEncryptionConfig` apply per-request: nothing here can run
  // without all five values, and a deployment that sets the poll interval
  // but forgets one of them should skip the sync rather than crash the
  // whole process on boot.
  if (
    env.MOTIVE_SYNC_POLL_MS > 0 &&
    env.MOTIVE_CLIENT_ID &&
    env.MOTIVE_CLIENT_SECRET &&
    env.MOTIVE_REDIRECT_URI &&
    env.CREDENTIAL_ENCRYPTION_PUBLIC_KEY &&
    env.CREDENTIAL_ENCRYPTION_PRIVATE_KEY
  ) {
    startMotiveSyncRunner(app, {
      intervalMs: env.MOTIVE_SYNC_POLL_MS,
      config: {
        clientId: env.MOTIVE_CLIENT_ID,
        clientSecret: env.MOTIVE_CLIENT_SECRET,
        redirectUri: env.MOTIVE_REDIRECT_URI,
      },
      publicKey: env.CREDENTIAL_ENCRYPTION_PUBLIC_KEY,
      privateKey: env.CREDENTIAL_ENCRYPTION_PRIVATE_KEY,
    });
  } else if (env.MOTIVE_SYNC_POLL_MS > 0) {
    app.log.warn(
      {},
      'MOTIVE_SYNC_POLL_MS is set but Motive or credential-encryption config is incomplete — sync will not run',
    );
  }

  await app.register(helmet);
  // Marketing (haulq.ai) and the app (app.haulq.ai) are separate origins by
  // design — build plan section 6 — so this is a real cross-origin setup, not
  // a development convenience.
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });

  /**
   * Liveness. Answers "is the process up", nothing more. Render polls this.
   */
  app.get('/health', async () => ({ status: 'ok' }));

  /**
   * Readiness. Answers "can this process serve a request", which means the
   * database. A health check that does not touch its dependencies reports green
   * through the outage it exists to catch.
   */
  app.get('/ready', async (_req, reply) => {
    try {
      await ping(db);
      return { status: 'ready', database: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });

  await app.register(requestContextPlugin);
  // Registered without fastify-plugin so its raw-body parser stays scoped to
  // the webhook route — the signature is over the bytes as sent.
  await app.register(webhookRoutes);
  await app.register(orgRoutes);
  await app.register(memberRoutes);
  await app.register(truckRoutes);
  await app.register(driverRoutes);
  await app.register(loadRoutes);
  await app.register(brokerRoutes);
  await app.register(trackRoutes);
  await app.register(feasibilityRoutes);
  await app.register(integrationRoutes);
  await app.register(payRoutes);
  await app.register(insightsRoutes);
  await app.register(importRoutes);
  // Registered without fastify-plugin so its binary body parser stays scoped
  // to these routes rather than applying to every upload in the API.
  await app.register(documentRoutes);
  // Unauthenticated-tenant, secret-gated — same family as webhookRoutes above,
  // just Basic Auth instead of an HMAC signature. Ordinary JSON body, so no
  // scoped content type parser needed.
  await app.register(postmarkInboundRoutes);
  await app.register(timelineRoutes);

  // Still to land:
  //   Phase 0b  /v1/verify

  return app;
}
