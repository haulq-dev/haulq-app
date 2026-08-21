/**
 * The exception-alert scan loop.
 *
 * PHASE_2_PLAN.md section 4's fifth line item: "no check-in in N hours
 * while in_transit, outbox + mailer." `findExceptionCandidates` and
 * `raiseExceptionAlert` in `@haulq/db` do the actual work; this is the
 * scheduling around it.
 *
 * Same shape as `outbox/loop.ts` — sleep between passes rather than a bare
 * interval, so a slow pass cannot stack with the next one; shutdown finishes
 * the pass in flight. Deliberately its own small loop rather than sharing
 * code with the outbox's: the unit of work here is a database sweep across
 * every org, not draining a claimed batch, and forcing both through one
 * abstraction would make neither easy to read for the size either one is.
 */

import { findExceptionCandidates, raiseExceptionAlert, type Database } from '@haulq/db';
import type { RuntimeLog } from '../runtime.ts';

export interface ExceptionScanLoopOptions {
  db: Database;
  /** Gap between passes. Must be > 0. */
  intervalMs: number;
  /** How long a load can go quiet in `in_transit` before it is an exception. */
  thresholdHours: number;
  log: RuntimeLog;
}

export interface ExceptionScanLoop {
  readonly finished: Promise<void>;
  stop(): Promise<void>;
}

/** One pass. Exported because it is the unit worth testing directly. */
export async function scanOnce(options: {
  db: Database;
  thresholdHours: number;
  log: RuntimeLog;
}): Promise<{ ok: boolean; alerted: number }> {
  try {
    const candidates = await findExceptionCandidates(options.db, options.thresholdHours);

    let alerted = 0;
    for (const candidate of candidates) {
      if (await raiseExceptionAlert(options.db, candidate)) alerted += 1;
    }

    // Silent when idle, same reasoning as the outbox loop: this runs every
    // few minutes, and "0 alerted" forever buries the lines that matter.
    if (alerted > 0) {
      options.log.info({ alerted, candidates: candidates.length }, 'exception scan raised alerts');
    }
    return { ok: true, alerted };
  } catch (error) {
    options.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'exception scan failed',
    );
    return { ok: false, alerted: 0 };
  }
}

export function startExceptionScanLoop(options: ExceptionScanLoopOptions): ExceptionScanLoop {
  if (options.intervalMs <= 0) {
    throw new Error(
      'startExceptionScanLoop needs a positive interval; use the caller to decide whether to run at all',
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
    options.log.info(
      { intervalMs: options.intervalMs, thresholdHours: options.thresholdHours },
      'exception scan loop started',
    );

    while (!stopping) {
      await scanOnce({ db: options.db, thresholdHours: options.thresholdHours, log: options.log });
      if (stopping) break;
      await pause(options.intervalMs);
    }

    options.log.info({}, 'exception scan loop stopped');
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
