/**
 * Running the outbox consumer inside the API process.
 *
 * **This is the fallback now, not the default.** Phase 1a put Azure Document
 * Intelligence in the pipeline, and an OCR pass takes seconds per page while
 * polling a remote operation. That work does not belong in the process serving
 * requests: one carrier uploading a forty-page packet should not be something
 * another carrier feels. `worker.ts` is the separate service that owns it.
 *
 * What this is still for:
 *
 *   - local development, where a second process is friction with no benefit
 *   - a deploy where the worker is not running yet, so invitations still send
 *
 * Behind a flag, because a poller that starts itself is a poller that runs in
 * every test, every CI job and every local `pnpm dev`, quietly draining rows
 * somebody was about to assert on. `OUTBOX_POLL_MS` defaults to 0.
 *
 * The loop itself is `loop.ts`, shared with the worker — see the note there on
 * why there is exactly one of them.
 */

import type { FastifyInstance } from 'fastify';
import type { OutboxGroup } from './handlers.ts';
import { startOutboxLoop } from './loop.ts';

export interface RunnerOptions {
  groups: OutboxGroup[];
  intervalMs: number;
}

export function startOutboxRunner(app: FastifyInstance, options: RunnerOptions): void {
  if (options.intervalMs <= 0) {
    // In production this is the expected state once the worker exists, but it
    // is also exactly what a lost environment variable looks like. Said out
    // loud either way, because the failure is silent: invitations stop sending
    // and documents stop being read, and nothing errors.
    const production = app.env.NODE_ENV === 'production';
    const message = production
      ? 'outbox runner disabled in this process (OUTBOX_POLL_MS is 0) — the haulq-worker service must be running, or nothing will send mail or read documents'
      : 'outbox runner disabled (OUTBOX_POLL_MS is 0)';
    app.log[production ? 'warn' : 'info']({}, message);
    return;
  }

  const loop = startOutboxLoop({
    db: app.db,
    groups: options.groups,
    intervalMs: options.intervalMs,
    log: app.log,
  });

  app.addHook('onClose', async () => {
    await loop.stop();
  });
}
