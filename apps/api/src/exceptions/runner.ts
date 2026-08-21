/**
 * Running the exception scan inside the API process.
 *
 * Same fallback reasoning `outbox/runner.ts` gives: `haulq-worker` is the
 * intended home once it is deployed, but it is not deployed yet (see
 * `render.yaml`), so this is what actually runs in production today, and
 * what makes the scan walkable in local development with no second process.
 *
 * Off by default for the same reason `OUTBOX_POLL_MS` is: a poller that
 * starts itself runs in every test and every local `pnpm dev`, quietly
 * emailing whoever is in `orgMemberships` about a test fixture's stale load.
 */

import type { FastifyInstance } from 'fastify';
import { startExceptionScanLoop } from './scan-loop.ts';

export interface ExceptionRunnerOptions {
  intervalMs: number;
  thresholdHours: number;
}

export function startExceptionScanRunner(app: FastifyInstance, options: ExceptionRunnerOptions): void {
  if (options.intervalMs <= 0) {
    app.log.info({}, 'exception scan disabled (EXCEPTION_SCAN_POLL_MS is 0)');
    return;
  }

  const loop = startExceptionScanLoop({
    db: app.db,
    intervalMs: options.intervalMs,
    thresholdHours: options.thresholdHours,
    log: app.log,
  });

  app.addHook('onClose', async () => {
    await loop.stop();
  });
}
