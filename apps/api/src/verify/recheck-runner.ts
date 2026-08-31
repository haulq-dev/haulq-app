/**
 * Running the nightly broker re-check inside the API process.
 *
 * Same fallback reasoning `exceptions/runner.ts` and `outbox/runner.ts`
 * both already give: `haulq-worker` is the intended home once it is
 * deployed, but it is not deployed yet, so this is what actually runs in
 * production today.
 *
 * Off by default for the same reason `EXCEPTION_SCAN_POLL_MS` is: a poller
 * that starts itself runs in every test and every local `pnpm dev`, quietly
 * spending FMCSA calls a developer's laptop has no business making.
 *
 * If this ever runs from two processes at once (this in-process runner
 * today, plus a future `haulq-worker`), two sweeps could race on the same
 * stale broker and both fire `broker.verification_changed` — a duplicate
 * email, not a duplicate or corrupted write, since `recordScheduledVerification`
 * is still individually transactional per call. Not worth cross-process
 * locking for what this is: worst case, a dispatcher reads the same email
 * twice.
 */

import type { FastifyInstance } from 'fastify';
import { startVerifyRecheckLoop } from './recheck-loop.ts';

export interface VerifyRecheckRunnerOptions {
  intervalMs: number;
  staleHours: number;
  fmcsaWebKey: string;
  fmcsaBaseUrl?: string | undefined;
}

export function startVerifyRecheckRunner(app: FastifyInstance, options: VerifyRecheckRunnerOptions): void {
  if (options.intervalMs <= 0) {
    app.log.info({}, 'verify recheck disabled (VERIFY_RECHECK_POLL_MS is 0)');
    return;
  }

  const loop = startVerifyRecheckLoop({
    db: app.db,
    intervalMs: options.intervalMs,
    staleHours: options.staleHours,
    fmcsaWebKey: options.fmcsaWebKey,
    fmcsaBaseUrl: options.fmcsaBaseUrl,
    log: app.log,
  });

  app.addHook('onClose', async () => {
    await loop.stop();
  });
}
