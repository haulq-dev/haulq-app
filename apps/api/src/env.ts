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

  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
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
