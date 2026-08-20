/**
 * The outbox drain loop, with no opinion about who is hosting it.
 *
 * One implementation, two callers: `runner.ts` runs it inside the API process,
 * `worker.ts` runs it as the whole point of a separate service. They were two
 * loops for about an hour and that was already one loop too many — the retry
 * behaviour, the overlap guard and the shutdown semantics are the parts most
 * likely to be subtly wrong, and having them differ between the process that
 * sends invitations and the process that reads documents is how a bug becomes
 * environment-specific.
 *
 * ---------------------------------------------------------------------------
 * Sleep between passes, never an interval
 * ---------------------------------------------------------------------------
 *
 * `setInterval` fires on a schedule regardless of whether the previous pass has
 * finished. With Azure in the chain a pass can take tens of seconds, so an
 * interval would stack overlapping drains that fight for the same rows and
 * multiply lease pressure. Sleeping *after* each pass means the gap is between
 * passes, which is what "poll every five seconds" was always meant to mean.
 *
 * ---------------------------------------------------------------------------
 * Shutdown finishes the pass
 * ---------------------------------------------------------------------------
 *
 * Render sends SIGTERM on every deploy. Aborting mid-handler would leave the
 * message leased until it expires, and it would then be redelivered — correct,
 * because delivery is at-least-once, but it means a second Azure analysis of a
 * page already analysed. Waiting out the current pass costs a few seconds of
 * deploy time and saves the duplicate.
 */

import { drainOutbox, type Database, type OutboxHandler } from '@haulq/db';
import type { RuntimeLog } from '../runtime.ts';

export interface OutboxLoopOptions {
  db: Database;
  handlers: Record<string, OutboxHandler>;
  /** Gap between passes. Must be > 0; a zero-interval loop is a busy wait. */
  intervalMs: number;
  batchSize?: number;
  log: RuntimeLog;
  /**
   * How long to wait after a *failed* drain, as opposed to a completed one.
   *
   * A drain throws when claiming itself failed, which means the database is
   * unreachable. Retrying every interval at that point produces a wall of
   * identical connection errors; backing off keeps the log readable and stops a
   * recovering database being hammered by every worker at once.
   */
  errorBackoffMs?: number;
}

export interface OutboxLoop {
  /** Resolves once the loop has stopped and any in-flight pass has finished. */
  readonly finished: Promise<void>;
  /** Ask the loop to stop after the current pass. */
  stop(): Promise<void>;
}

/**
 * Run one pass. Exported because it is the unit worth testing directly.
 *
 * Never throws: a drain failure is logged and reported, because the caller's
 * correct response is to wait and try again rather than to crash the process.
 * A worker that exits on a transient database blip turns a ten-second outage
 * into a deploy.
 */
export async function drainOnce(options: {
  db: Database;
  handlers: Record<string, OutboxHandler>;
  batchSize?: number;
  log: RuntimeLog;
}): Promise<{ ok: boolean; claimed: number }> {
  try {
    const result = await drainOutbox(options.db, {
      handlers: options.handlers,
      ...(options.batchSize ? { batchSize: options.batchSize } : {}),
      // The invite payload carries a live token. Once the mail is away there is
      // no reason for it to stay in a processed row.
      scrubPayloadOnSuccess: true,
      onError: (message, error) =>
        options.log.error(
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
    if (result.claimed > 0) options.log.info({ ...result }, 'outbox drained');
    if (result.exhausted > 0) {
      options.log.warn(
        { exhausted: result.exhausted },
        'outbox messages gave up — see outboxDeadLetters',
      );
    }

    return { ok: true, claimed: result.claimed };
  } catch (error) {
    options.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'outbox drain failed',
    );
    return { ok: false, claimed: 0 };
  }
}

export function startOutboxLoop(options: OutboxLoopOptions): OutboxLoop {
  if (options.intervalMs <= 0) {
    throw new Error('startOutboxLoop needs a positive interval; use the caller to decide whether to run at all');
  }

  const errorBackoffMs = options.errorBackoffMs ?? Math.max(options.intervalMs, 5_000);
  let stopping = false;
  let wake: (() => void) | null = null;

  /** Sleep, but return early if `stop` is called meanwhile. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      // Not holding the event loop open is what lets a `pnpm dev` exit and a
      // test finish without an explicit stop.
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const finished = (async () => {
    options.log.info(
      { intervalMs: options.intervalMs, topics: Object.keys(options.handlers) },
      'outbox loop started',
    );

    while (!stopping) {
      const pass = await drainOnce({
        db: options.db,
        handlers: options.handlers,
        ...(options.batchSize ? { batchSize: options.batchSize } : {}),
        log: options.log,
      });

      if (stopping) break;

      // A full batch means there is probably more waiting, so go straight round
      // again rather than sleeping on a backlog. This is what lets a carrier
      // who uploads forty documents at once drain in seconds instead of
      // minutes.
      const more = pass.ok && pass.claimed > 0;
      await pause(pass.ok ? (more ? 0 : options.intervalMs) : errorBackoffMs);
    }

    options.log.info({}, 'outbox loop stopped');
  })();

  return {
    finished,
    async stop() {
      stopping = true;
      wake?.();
      await finished;
    },
  };
}
