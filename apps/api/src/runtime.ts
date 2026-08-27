/**
 * The dependencies a HaulQ process needs, however it was started.
 *
 * Two entry points now use these: the API in `server.ts`, and the outbox worker
 * in `worker.ts`. They live here rather than in `server.ts` for one reason, and
 * it is not tidiness — **a worker that builds its storage or its reader
 * differently from the API is a bug that only appears in production.** The
 * worker writes what the API reads. If one of them picks R2 and the other picks
 * the local disk, every document uploaded through the API becomes unreadable to
 * the process meant to extract it, and the only symptom is documents that sit at
 * `received` forever.
 *
 * So there is one implementation of each decision, and both processes call it.
 *
 * Each of these logs which choice it made. That is deliberate and it is the
 * same argument every time: "the feature is quietly not working" and "the secret
 * never reached this deploy" are otherwise the same symptom, and none of this
 * runs where anyone is watching.
 */

import {
  FilesystemObjectStore,
  r2FromEnv,
  type ObjectStore,
} from '@haulq/db';
import { AzureDocumentReader, ChainedDocumentReader } from './documents/azure-reader.ts';
import { AnthropicModelReader, type ModelDocumentReader } from './documents/model-reader.ts';
import { LocalDocumentReader, type DocumentReader } from './documents/reader.ts';
import { LogMailer, PostmarkMailer, type Mailer } from './email/postmark.ts';
import type { Env } from './env.ts';
import { HereRoutingProvider } from './integrations/here.ts';
import type { RoutingProvider } from './integrations/routing-provider.ts';

/**
 * The logging surface these builders need.
 *
 * Narrower than Fastify's logger on purpose, so `worker.ts` does not have to
 * construct a Fastify instance to get one. `FastifyBaseLogger` satisfies it
 * structurally, so the API passes `app.log` unchanged.
 */
export interface RuntimeLog {
  info(o: unknown, msg: string): void;
  warn(o: unknown, msg: string): void;
  error(o: unknown, msg: string): void;
}

/**
 * R2 in production, the local filesystem otherwise.
 *
 * Decided by whether the R2 variables are present, not by NODE_ENV, so a
 * staging deploy or a laptop holding real credentials behaves exactly like
 * production without a second switch to keep in step.
 */
export function buildStorage(env: Env, log: RuntimeLog): ObjectStore {
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
 * The document reader, cheapest pass first.
 *
 * Always starts with the text layer, which costs an inflate and handles the
 * commonest document HaulQ sees — a rate confirmation a broker's TMS generated
 * as a digital PDF. Azure is appended when it is configured, and only ever sees
 * what the first pass declined.
 *
 * That ordering is the cost control, and it is expressed as a list here rather
 * than as a rule somewhere for exactly one reason: the way to make HaulQ pay
 * Azure for documents it could read for free is to reorder this array, which is
 * a thing somebody has to do on purpose.
 */
export function buildDocumentReader(env: Env, log: RuntimeLog): DocumentReader {
  const local = new LocalDocumentReader();

  if (!env.AZURE_DI_ENDPOINT || !env.AZURE_DI_KEY) {
    log.info(
      { readers: local.name, ocr: false },
      'document reader ready — digital PDFs only, scans and photos will wait for OCR. Set AZURE_DI_ENDPOINT and AZURE_DI_KEY to read them.',
    );
    return local;
  }

  const chain = new ChainedDocumentReader([
    local,
    new AzureDocumentReader({ endpoint: env.AZURE_DI_ENDPOINT, key: env.AZURE_DI_KEY }),
  ]);
  log.info({ readers: chain.name, ocr: true }, 'document reader ready');
  return chain;
}

/**
 * The model pass, when a key is configured.
 *
 * Undefined otherwise — `processDocument` treats an unset `modelReader`
 * exactly as it did before this existed, so a fresh clone and CI both work
 * with no account, same as Azure above.
 */
export function buildModelReader(env: Env, log: RuntimeLog): ModelDocumentReader | undefined {
  if (!env.ANTHROPIC_API_KEY) {
    log.info({ modelPass: false }, 'model pass not configured — set ANTHROPIC_API_KEY to read what the deterministic rules decline');
    return undefined;
  }

  const reader = new AnthropicModelReader({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL });
  log.info({ modelPass: true, model: reader.name }, 'model pass ready');
  return reader;
}

/**
 * Postmark when a token exists, a logger when it does not.
 *
 * Same shape as `buildStorage`, and the same reason for the warning: a
 * production deploy quietly not sending mail looks exactly like a deploy whose
 * secret never arrived, and the first symptom is an invitation nobody receives.
 */
export function buildMailer(env: Env, log: RuntimeLog): Mailer {
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

/**
 * HERE when a key is configured, undefined otherwise — same shape as
 * `buildModelReader` above. `POST /v1/loads/:id/feasibility` treats an unset
 * provider exactly as `routes/integrations.ts` treats an unset Motive
 * config: a 503, not a crash and not a guess. See `env.ts`'s note on
 * `HERE_API_KEY` for why this is a platform-level credential rather than a
 * per-org one.
 */
export function buildRoutingProvider(env: Env, log: RuntimeLog): RoutingProvider | undefined {
  if (!env.HERE_API_KEY) {
    log.info(
      { routingProvider: false },
      'HERE is not configured — feasibility checks are unavailable. Set HERE_API_KEY to enable them.',
    );
    return undefined;
  }

  log.info({ routingProvider: 'here' }, 'routing provider ready');
  return env.HERE_BASE_URL
    ? new HereRoutingProvider({ apiKey: env.HERE_API_KEY }, env.HERE_BASE_URL)
    : new HereRoutingProvider({ apiKey: env.HERE_API_KEY });
}
