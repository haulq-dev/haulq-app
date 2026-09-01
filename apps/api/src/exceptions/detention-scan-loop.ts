/**
 * The detention-alert scan loop.
 *
 * `findDetentionCandidates`/`raiseDetentionAlert` in `@haulq/db` do the
 * actual work; this is the scheduling around it — the same shape
 * `scan-loop.ts` already uses for exceptions, deliberately its own loop
 * rather than shared code, for the reason that file's own module note gives:
 * the unit of work differs (a per-stop dwell check here, an activity-
 * staleness check there) enough that forcing both through one abstraction
 * would make neither easy to read for the size either one is.
 */

import { findDetentionCandidates, raiseDetentionAlert, type Database } from '@haulq/db';
import type { RuntimeLog } from '../runtime.ts';

export interface DetentionScanLoopOptions {
  db: Database;
  /** Gap between passes. Must be > 0. */
  intervalMs: number;
  log: RuntimeLog;
}

export interface DetentionScanLoop {
  readonly finished: Promise<void>;
  stop(): Promise<void>;
}

/** One pass. Exported because it is the unit worth testing directly. */
export async function scanOnce(options: {
  db: Database;
  log: RuntimeLog;
}): Promise<{ ok: boolean; alerted: number }> {
  try {
    const candidates = await findDetentionCandidates(options.db);

    let alerted = 0;
    for (const candidate of candidates) {
      if (await raiseDetentionAlert(options.db, candidate)) alerted += 1;
    }

    if (alerted > 0) {
      options.log.info({ alerted, candidates: candidates.length }, 'detention scan raised alerts');
    }
    return { ok: true, alerted };
  } catch (error) {
    options.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'detention scan failed',
    );
    return { ok: false, alerted: 0 };
  }
}

export function startDetentionScanLoop(options: DetentionScanLoopOptions): DetentionScanLoop {
  if (options.intervalMs <= 0) {
    throw new Error(
      'startDetentionScanLoop needs a positive interval; use the caller to decide whether to run at all',
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
    options.log.info({ intervalMs: options.intervalMs }, 'detention scan loop started');

    while (!stopping) {
      await scanOnce({ db: options.db, log: options.log });
      if (stopping) break;
      await pause(options.intervalMs);
    }

    options.log.info({}, 'detention scan loop stopped');
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
