/**
 * Running the Motive sync inside the API process.
 *
 * Same fallback reasoning as `outbox/runner.ts` and `exceptions/runner.ts`:
 * `haulq-worker` is the intended home once it is deployed, but it is not
 * deployed yet, so this is what actually runs the sync in production today.
 * Off by default — see `MOTIVE_SYNC_POLL_MS`'s note in `env.ts`.
 */

import type { FastifyInstance } from 'fastify';
import { startMotiveSyncLoop } from './motive-sync-loop.ts';
import type { MotiveOAuthConfig } from './motive.ts';

export interface MotiveSyncRunnerOptions {
  intervalMs: number;
  config: MotiveOAuthConfig;
  publicKey: string;
  privateKey: string;
}

export function startMotiveSyncRunner(app: FastifyInstance, options: MotiveSyncRunnerOptions): void {
  if (options.intervalMs <= 0) {
    app.log.info({}, 'motive sync disabled (MOTIVE_SYNC_POLL_MS is 0)');
    return;
  }

  const loop = startMotiveSyncLoop({
    db: app.db,
    config: options.config,
    publicKey: options.publicKey,
    privateKey: options.privateKey,
    intervalMs: options.intervalMs,
    log: app.log,
  });

  app.addHook('onClose', async () => {
    await loop.stop();
  });
}
