/**
 * Running the status advance loop inside the API process, for the same
 * reason `exceptions/detention-runner.ts` gives: `haulq-worker` isn't
 * deployed yet, so this is what runs in production.
 *
 * Off by default like every other poller here. A poller that starts itself
 * runs in every test and every local `pnpm dev`, moving fixture loads along.
 */

import type { FastifyInstance } from 'fastify';
import { startStatusAdvanceLoop } from './status-advance-loop.ts';

export function startStatusAdvanceRunner(app: FastifyInstance, options: { intervalMs: number }): void {
  if (options.intervalMs <= 0) {
    app.log.info({}, 'status advance disabled (STATUS_ADVANCE_POLL_MS is 0)');
    return;
  }

  const loop = startStatusAdvanceLoop({
    db: app.db,
    intervalMs: options.intervalMs,
    log: app.log,
  });

  app.addHook('onClose', async () => {
    await loop.stop();
  });
}
