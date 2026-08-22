/**
 * The Motive position sync loop.
 *
 * Same shape as `exceptions/scan-loop.ts` and `outbox/loop.ts` — sleep
 * between passes so a slow pass cannot stack with the next one, shutdown
 * finishes the pass in flight. A third near-identical loop rather than a
 * shared abstraction for the same reason the exception scan already chose
 * that: three different units of work (draining a queue, sweeping for
 * quiet loads, polling an external API across every connected org) forced
 * through one generic loop would make all three harder to read for what
 * each one actually is.
 */

import { syncAllMotivePositions, type SyncDeps } from './motive-sync.ts';

export interface MotiveSyncLoopOptions extends SyncDeps {
  intervalMs: number;
}

export interface MotiveSyncLoop {
  readonly finished: Promise<void>;
  stop(): Promise<void>;
}

/** One pass. Exported because it is the unit worth testing directly. */
export async function syncOnce(deps: SyncDeps): Promise<{ ok: boolean; positionsWritten: number }> {
  try {
    const result = await syncAllMotivePositions(deps);
    if (result.positionsWritten > 0) {
      deps.log.info(result, 'motive sync wrote positions');
    }
    return { ok: true, positionsWritten: result.positionsWritten };
  } catch (error) {
    deps.log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'motive sync pass failed',
    );
    return { ok: false, positionsWritten: 0 };
  }
}

export function startMotiveSyncLoop(options: MotiveSyncLoopOptions): MotiveSyncLoop {
  if (options.intervalMs <= 0) {
    throw new Error(
      'startMotiveSyncLoop needs a positive interval; use the caller to decide whether to run at all',
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
    options.log.info({ intervalMs: options.intervalMs }, 'motive sync loop started');

    while (!stopping) {
      await syncOnce(options);
      if (stopping) break;
      await pause(options.intervalMs);
    }

    options.log.info({}, 'motive sync loop stopped');
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
