/**
 * Environment, validated once at boot.
 *
 * The point is to fail on startup rather than on the first request that
 * happens to need a missing variable. A Render deploy that boots and then 502s
 * an hour later on the first document upload is a worse outcome than one that
 * refuses to boot.
 */

import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  // Optional at Phase 0. Each becomes required as its phase lands, and the
  // right place to make that change is here, not at the call site.
  /**
   * Auth provider. `dev` trusts request headers and refuses to run in
   * production; `clerk` needs CLERK_SECRET_KEY. Explicit rather than inferred
   * from whether a key happens to be set — a typo'd variable name should fail
   * loudly, not silently downgrade a deployment to header-trusting auth.
   */
  AUTH_PROVIDER: z.enum(['dev', 'clerk']).default('dev'),
  CLERK_SECRET_KEY: z.string().optional(),
  /** From the Clerk dashboard's webhook endpoint. `whsec_...`. */
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),          // Phase 1a, documents
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('haulq-documents'),

  /**
   * Where the filesystem object store writes. Ignored once R2 is configured.
   * Defaults under the OS temp dir so a fresh clone runs with no setup.
   */
  STORAGE_DIR: z.string().default('/tmp/haulq-storage'),

  /**
   * Azure AI Document Intelligence. Optional, and optional on purpose.
   *
   * Without it the document pipeline still reads digital PDFs — the text layer
   * pass needs no account and no network. What Azure adds is OCR for the pile
   * that has none: photographs of signed BOLs, faxed scale tickets, scans. So a
   * fresh clone and CI both work unset, and setting it changes which documents
   * can be read rather than whether the feature exists.
   *
   * `prebuilt-read` is the model, chosen in `azure-reader.ts` and not
   * configurable here — see the note there on why layout is the expensive
   * mistake.
   */
  AZURE_DI_ENDPOINT: z.string().url().optional(),
  AZURE_DI_KEY: z.string().optional(),

  /**
   * The model pass, for documents the deterministic rules decline — a
   * photograph nobody templated, a packet where several kinds matched, a
   * confidently-classified document missing a field no label named. Optional,
   * same reasoning as Azure above: without a key, `processDocument` still
   * does everything it did before this existed, just with more documents
   * left as `needs: 'model'` for a person to look at rather than a model.
   *
   * `ANTHROPIC_MODEL` defaults to a Haiku-tier model deliberately — this is
   * the "screen cheap" half of the same argument `haulq-dispatcher`'s
   * scoring makes for itself: called only after three free passes already
   * declined, so it does not need to be the largest model available, only a
   * careful one. See `documents/model-reader.ts` for why it is not trusted
   * with a single field it cannot point at verbatim on the page.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  /**
   * Postmark. Optional: with no token the mailer logs instead of sending, which
   * is what makes the invite flow walkable locally with no account.
   */
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  /** Must be on a Postmark-verified domain, or every send is rejected. */
  EMAIL_FROM: z.string().email().default('hello@haulq.ai'),

  /**
   * Postmark inbound webhook, for HaulQ Docs email intake. Both optional
   * together, same pattern as CLERK_WEBHOOK_SECRET — the route itself 503s
   * rather than accepting unverified when either is unset. There is no HMAC
   * scheme on Postmark's inbound parse webhook, unlike its outbound delivery
   * events, so this is HTTP Basic Auth: set in the Postmark inbound stream's
   * webhook URL as `https://user:password@api.haulq.ai/v1/webhooks/postmark-inbound`.
   */
  POSTMARK_INBOUND_USER: z.string().optional(),
  POSTMARK_INBOUND_PASSWORD: z.string().optional(),

  /**
   * How often the in-process outbox consumer polls, in milliseconds. 0 is off.
   *
   * Off by default on purpose. A poller that starts itself runs in every test
   * and every local `pnpm dev`, quietly draining rows something was about to
   * assert on. Render sets it; nothing else does.
   */
  OUTBOX_POLL_MS: z.coerce.number().int().min(0).default(0),

  /**
   * How often the exception scan sweeps for quiet `in_transit` loads, in
   * milliseconds. 0 is off, same reasoning and same default as
   * `OUTBOX_POLL_MS` — see `exceptions/runner.ts`.
   */
  EXCEPTION_SCAN_POLL_MS: z.coerce.number().int().min(0).default(0),
  /**
   * How many hours a load can sit in `in_transit` with no check-in and no
   * position update before it is an exception. Four hours is a guess at a
   * reasonable check-call cadence, not a researched figure — PHASE_2_PLAN.md
   * section 7 does not name a value, so this is a deployment default, not a
   * decision this file is entitled to consider settled. Unlike the
   * detention-timer threshold that section also leaves open, this one is
   * not billing-facing — it changes when a dispatcher gets nagged, not what
   * a carrier charges — so a wrong guess here costs an email, not a dispute.
   */
  EXCEPTION_THRESHOLD_HOURS: z.coerce.number().int().min(1).default(4),

  /**
   * How often the detention scan sweeps for stops currently over free time,
   * in milliseconds. 0 is off, same reasoning and same default as
   * `EXCEPTION_SCAN_POLL_MS` — see `exceptions/detention-runner.ts`. No
   * companion threshold constant the way the exception scan has one: the
   * threshold here is each broker's own `detentionFreeMinutes` (or
   * `DEFAULT_DETENTION_FREE_MINUTES`), already a per-broker decision rather
   * than a deployment-wide guess.
   */
  DETENTION_SCAN_POLL_MS: z.coerce.number().int().min(0).default(0),

  /**
   * How often the nightly broker re-check sweeps for stale FMCSA checks, in
   * milliseconds. 0 is off, same reasoning and same default as
   * `EXCEPTION_SCAN_POLL_MS` — see `verify/recheck-runner.ts`. Set well
   * below a day on purpose (a recommended value is 6h): the sweep frequency
   * and how stale a check has to be before it is re-run are two different
   * numbers, the second one being `VERIFY_RECHECK_STALE_HOURS` below, the
   * same decoupling `EXCEPTION_SCAN_POLL_MS`/`EXCEPTION_THRESHOLD_HOURS`
   * already uses.
   */
  VERIFY_RECHECK_POLL_MS: z.coerce.number().int().min(0).default(0),
  /** How many hours a broker's last FMCSA check can stand before the nightly sweep re-checks it. */
  VERIFY_RECHECK_STALE_HOURS: z.coerce.number().int().min(1).default(24),

  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

  /**
   * Motive (2b's ELD provider). All optional together: `/v1/integrations/
   * motive/connect` 503s rather than accepting a connection nobody can
   * finish — same pattern `POSTMARK_INBOUND_USER`/`_PASSWORD` already use.
   *
   * `MOTIVE_REDIRECT_URI` has to exactly match what is registered in
   * Motive's developer dashboard for this OAuth app, or the authorization
   * step fails on their side before HaulQ ever sees it.
   */
  MOTIVE_CLIENT_ID: z.string().optional(),
  MOTIVE_CLIENT_SECRET: z.string().optional(),
  MOTIVE_REDIRECT_URI: z.string().url().optional(),

  /**
   * `credential-crypto.ts`'s sealed-box keypair. Both optional together —
   * without them Motive's OAuth callback has nowhere safe to put the token
   * it just received, so it refuses rather than storing one unsealed.
   * Generate with `generateCredentialKeypair()` once, by hand; nothing
   * rotates these automatically.
   */
  CREDENTIAL_ENCRYPTION_PUBLIC_KEY: z.string().optional(),
  CREDENTIAL_ENCRYPTION_PRIVATE_KEY: z.string().optional(),

  /**
   * How often the Motive position sync sweeps every connected org, in
   * milliseconds. 0 is off — same default and same reasoning as
   * `OUTBOX_POLL_MS`/`EXCEPTION_SCAN_POLL_MS`: a poller that starts itself
   * runs in every test and every local `pnpm dev`.
   */
  MOTIVE_SYNC_POLL_MS: z.coerce.number().int().min(0).default(0),

  /**
   * FMCSA QCMobile, for Phase 0b's broker lookup. A single platform-level
   * developer credential, not a per-org secret — `HAULQ_BUILD_PLAN.md` §11's
   * own note: "separate from a carrier's own USDOT/MC or FMCSA Portal
   * account." Optional, same degrade-rather-than-fail pattern as every other
   * external service here: without it, `POST /v1/brokers/:id/verify` 503s.
   */
  FMCSA_WEBKEY: z.string().optional(),
  /** Override for tests only — production never sets this. */
  FMCSA_BASE_URL: z.string().url().optional(),

  /**
   * HERE Routing API, Phase 3a's routing provider — `PHASE_3_PLAN.md` section
   * 7a. A single platform-level developer credential, same shape as
   * `FMCSA_WEBKEY` above rather than a per-org `board_credentials` row: one
   * HaulQ-owned HERE account serves every tenant's feasibility checks, the
   * same way one FMCSA webkey serves every broker lookup. Optional, same
   * degrade-rather-than-fail pattern as every other external service here —
   * without it, `POST /v1/loads/:id/feasibility` 503s. `HAULQ_BUILD_PLAN.md`
   * section 11 notes HERE needs a card on file for the 30k/month free tier;
   * that signup has not happened as of this writing.
   */
  HERE_API_KEY: z.string().optional(),
  /** Override for tests only — production never sets this. */
  HERE_BASE_URL: z.string().url().optional(),
  /**
   * Same account, same `HERE_API_KEY` — HERE Geocoding is a different
   * endpoint under the same project, not a separate credential. Override
   * for tests only, same as `HERE_BASE_URL`.
   */
  HERE_GEOCODE_BASE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
