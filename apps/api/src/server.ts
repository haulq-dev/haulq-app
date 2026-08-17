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
  FilesystemObjectStore,
  ping,
  type Database,
  type ObjectStore,
} from '@haulq/db';
import type { Authenticator } from './auth/authenticator.ts';
import { ClerkAuthenticator } from './auth/clerk-authenticator.ts';
import { DevAuthenticator } from './auth/dev-authenticator.ts';
import type { Env } from './env.ts';
import { requestContextPlugin } from './plugins/request-context.ts';
import { driverRoutes } from './routes/drivers.ts';
import { importRoutes } from './routes/imports.ts';
import { memberRoutes } from './routes/members.ts';
import { orgRoutes } from './routes/orgs.ts';
import { timelineRoutes } from './routes/timeline.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { truckRoutes } from './routes/trucks.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    env: Env;
    storage: ObjectStore;
  }
}

export interface BuildOptions {
  /**
   * Override object storage. Tests inject an in-memory store; production will
   * inject R2 once the bucket and Doppler secrets exist. Defaults to the local
   * filesystem — see the note in `packages/db/src/storage.ts`.
   */
  storage?: ObjectStore;

  /**
   * Override the authenticator. Tests inject a fake; production will inject
   * Clerk. Defaults to the dev stub, which refuses to construct outside
   * development.
   */
  authenticator?: Authenticator;
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
  app.decorate(
    'storage',
    options.storage ?? new FilesystemObjectStore(env.STORAGE_DIR),
  );

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
  await app.register(importRoutes);
  await app.register(timelineRoutes);

  // Still to land:
  //   Phase 0   /v1/loads
  //   Phase 0b  /v1/verify
  //   Phase 1a  /v1/documents

  return app;
}
