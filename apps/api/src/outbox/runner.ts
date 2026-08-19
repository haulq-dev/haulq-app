/**
 * Running the outbox consumer in the API process.
 *
 * Deliberately in-process, and deliberately behind a flag.
 *
 * In-process because the only work today is sending a handful of invitations,
 * and a second Render service for that is a second deploy target, a second
 * Doppler config and a second thing to notice has stopped. Multiple API
 * instances are safe: the claim uses `FOR UPDATE SKIP LOCKED`, so they take
 * disjoint sets rather than double-sending.
 *
 * **When to stop doing this:** Phase 1a. Document extraction calls Azure and
 * takes seconds per page, and that does not belong in the process serving
 * requests. The drain logic lives in `@haulq/db` precisely so moving it is an
 * entrypoint and a `render.yaml` block, not a rewrite.
 *
 * Behind a flag because a poller that starts itself is a poller that runs in
 * every test, every CI job and every local `pnpm dev`, quietly draining rows
 * somebody was about to assert on.
 */

import { drainOutbox, type OutboxHandler } from '@haulq/db';
import type { FastifyInstance } from 'fastify';

export interface RunnerOptions {
  handlers: Record<string, OutboxHandler>;
  intervalMs: number;
  batchSize?: number;
}

export function startOutboxRunner(
  app: FastifyInstance,
  options: RunnerOptions,
): void {
  if (options.intervalMs <= 0) {
    app.log.info('outbox runner disabled (OUTBOX_POLL_MS is 0)');
    return;
  }

  const topics = Object.keys(options.handlers);
  let running = false;
  let stopped = false;

  const tick = async () => {
    // One pass at a time. A slow mailer must not stack overlapping drains that
    // fight each other for the same rows and multiply the lease pressure.
    if (running || stopped) return;
    running = true;
    try {
      const result = await drainOutbox(app.db, {
        handlers: options.handlers,
        ...(options.batchSize ? { batchSize: options.batchSize } : {}),
        // The invite payload carries a live token. Once the mail is away there
        // is no reason for it to stay in a processed row.
        scrubPayloadOnSuccess: true,
        onError: (message, error) =>
          app.log.error(
            {
              seq: message.seq.toString(),
              topic: message.topic,
              attempts: message.attempts,
              err: error instanceof Error ? error.message : String(error),
            },
            'outbox handler failed',
          ),
      });

      // Silent when idle. This runs every few seconds; logging "claimed 0"
      // forever buries the lines that matter.
      if (result.claimed > 0) {
        app.log.info({ ...result }, 'outbox drained');
      }
      if (result.exhausted > 0) {
        app.log.warn(
          { exhausted: result.exhausted },
          'outbox messages gave up — see outboxDeadLetters',
        );
      }
    } catch (error) {
      // Claiming itself failed, which means the database is unreachable. Log
      // and let the next tick try; throwing here would take an unhandled
      // rejection into the process.
      app.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'outbox drain failed',
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  // Do not hold the process open. Without this a `pnpm dev` refuses to exit and
  // the test runner reports a hang with no failing assertion.
  timer.unref();

  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(timer);
  });

  app.log.info(
    { intervalMs: options.intervalMs, topics },
    'outbox runner started',
  );
}
