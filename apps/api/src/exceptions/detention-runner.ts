/**
 * Running the detention scan inside the API process.
 *
 * Same fallback reasoning `exceptions/runner.ts` gives for its own loop:
 * `haulq-worker` is the intended home once it is deployed, but it is not
 * deployed yet (see `render.yaml`), so this is what actually runs in
 * production today.
 *
 * Off by default for the same reason every other poller in this codebase
 * is: a poller that starts itself runs in every test and every local
 * `pnpm dev`, quietly emailing whoever is in `orgMemberships` about a test
 * fixture's stop.
 */

import type { FastifyInstance } from 'fastify';
import { startDetentionScanLoop } from './detention-scan-loop.ts';

export interface DetentionRunnerOptions {
  intervalMs: number;
}

export function startDetentionScanRunner(app: FastifyInstance, options: DetentionRunnerOptions): void {
  if (options.intervalMs <= 0) {
    app.log.info({}, 'detention scan disabled (DETENTION_SCAN_POLL_MS is 0)');
    return;
  }

  const loop = startDetentionScanLoop({
    db: app.db,
    intervalMs: options.intervalMs,
    log: app.log,
  });

  app.addHook('onClose', async () => {
    await loop.stop();
  });
}
