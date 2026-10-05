/**
 * The loop that moves loads along from their drivers' check-ins.
 *
 * `findStatusAdvanceCandidates`/`advanceLoadStatus` in `@haulq/db` hold the
 * rules (see `repositories/status-advance.ts` for why this is a sweep rather
 * than part of the check-in write); this is only the scheduling, the same
 * shape as `exceptions/detention-scan-loop.ts`.
 */

import { advanceLoadStatus, findStatusAdvanceCandidates, type Database } from '@haulq/db';
import type { RuntimeLog } from '../runtime.ts';

export interface StatusAdvanceLoopOptions {
  db: Database;
  /** Gap between passes. Must be > 0. */
  intervalMs: number;
  log: RuntimeLog;
}

export interface StatusAdvanceLoop {
  readonly finished: Promise<void>;
  stop(): Promise<void>;
}

/** One pass. Exported because it is the unit worth testing directly. */
export async function advanceOnce(options: {
  db: Database;
  log: RuntimeLog;
}): Promise<{ ok: boolean; advanced: number }> {
  try {
    const candidates = await findStatusAdvanceCandidates(options.db);

    // One load at a time, each failure logged and passed over: a single
    // load the database refuses must not hold every other carrier's loads
    // back on every pass.
    let advanced = 0;
    for (const candidate of candidates) {
      try {
        if (await advanceLoadStatus(options.db, candidate)) advanced += 1;
      } catch (error) {
        options.log.warn(
          { loadId: candidate.loadId, to: candidate.to, err: error instanceof Error ? error.message : String(error) },
          'status advance skipped a load',
        );
      }
    }

    if (advanced > 0) {
      options.log.info({ advanced, candidates: candidates.length }, 'status advance moved loads');
    }
    return { ok: true, advanced };
  } catch (error) {
    options.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'status advance failed',
    );
    return { ok: false, advanced: 0 };
  }
}

export function startStatusAdvanceLoop(options: StatusAdvanceLoopOptions): StatusAdvanceLoop {
  if (options.intervalMs <= 0) {
    throw new Error(
      'startStatusAdvanceLoop needs a positive interval; use the caller to decide whether to run at all',
    );
  }

  let stopping = false;
  let wake: (() => void) | null = null;

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const finished = (async () => {
    options.log.info({ intervalMs: options.intervalMs }, 'status advance loop started');

    while (!stopping) {
      await advanceOnce({ db: options.db, log: options.log });
      if (stopping) break;
      await pause(options.intervalMs);
    }

    options.log.info({}, 'status advance loop stopped');
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
