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
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  closeDatabase,
  createDatabase,
  FilesystemObjectStore,
  ping,
  r2FromEnv,
  R2ObjectStore,
  type Database,
  type ObjectStore,
} from '@haulq/db';
import type { Authenticator } from './auth/authenticator.ts';
import { ClerkAuthenticator } from './auth/clerk-authenticator.ts';
import { DevAuthenticator } from './auth/dev-authenticator.ts';
import type { Env } from './env.ts';
import { LogMailer, PostmarkMailer, type Mailer } from './email/postmark.ts';
import { buildOutboxHandlers } from './outbox/handlers.ts';
import { startOutboxRunner } from './outbox/runner.ts';
import { requestContextPlugin } from './plugins/request-context.ts';
import { driverRoutes } from './routes/drivers.ts';
import { importRoutes } from './routes/imports.ts';
import { insightsRoutes } from './routes/insights.ts';
import { loadRoutes } from './routes/loads.ts';
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

/**
 * R2 in production, the local filesystem otherwise.
 *
 * Decided by whether the R2 variables are present, not by NODE_ENV, so a
 * staging deploy or a laptop holding real credentials behaves exactly like
 * production without a second switch to keep in step.
 *
 * **It logs which one it chose.** Without that line, "the carrier's upload
 * disappeared" and "the R2 secrets never reached this deploy" are the same
 * symptom, and the import pipeline is staged across requests so the gap
 * between them is hours.
 */
function buildStorage(env: Env, log: FastifyBaseLogger): ObjectStore {
  const r2 = r2FromEnv(env);
  if (r2) {
    log.info({ store: 'r2', bucket: env.R2_BUCKET }, 'object storage ready');
    return r2;
  }

  if (env.NODE_ENV === 'production') {
    // Render's disk does not survive a deploy or a restart. An import is
    // uploaded in one request and committed in another, often an hour later
    // while the carrier checks the column mapping — so this is not a
    // theoretical risk, it is the normal path.
    log.warn(
      { store: 'filesystem', dir: env.STORAGE_DIR },
      'object storage is the local disk IN PRODUCTION — uploads will not survive a deploy. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.',
    );
  } else {
    log.info({ store: 'filesystem', dir: env.STORAGE_DIR }, 'object storage ready');
  }

  return new FilesystemObjectStore(env.STORAGE_DIR);
}

/**
 * Postmark when a token exists, a logger when it does not.
 *
 * Same shape as `buildStorage`, and the same reason for the warning: a
 * production deploy quietly not sending mail looks exactly like a deploy whose
 * secret never arrived, and the first symptom is an invitation nobody receives.
 */
function buildMailer(env: Env, log: FastifyBaseLogger): Mailer {
  if (env.POSTMARK_SERVER_TOKEN) {
    log.info({ mailer: 'postmark', from: env.EMAIL_FROM }, 'mailer ready');
    return new PostmarkMailer({
      token: env.POSTMARK_SERVER_TOKEN,
      from: env.EMAIL_FROM,
    });
  }

  const message =
    env.NODE_ENV === 'production'
      ? 'no POSTMARK_SERVER_TOKEN — invitations WILL NOT BE SENT, only logged'
      : 'mailer ready';
  const level = env.NODE_ENV === 'production' ? 'warn' : 'info';
  log[level]({ mailer: 'log' }, message);

  return new LogMailer((o, msg) => log.info(o, msg));
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
  startOutboxRunner(app, {
    handlers: buildOutboxHandlers({
      mailer,
      webOrigin: env.WEB_ORIGIN,
      log: {
        info: (o, msg) => app.log.info(o, msg),
        warn: (o, msg) => app.log.warn(o, msg),
      },
    }),
    intervalMs: env.OUTBOX_POLL_MS,
  });

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
  await app.register(insightsRoutes);
  await app.register(importRoutes);
  await app.register(timelineRoutes);

  // Still to land:
  //   Phase 0   /v1/loads
  //   Phase 0b  /v1/verify
  //   Phase 1a  /v1/documents

  return app;
}
