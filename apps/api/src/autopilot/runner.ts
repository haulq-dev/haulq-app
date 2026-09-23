/**
 * Running the autopilot loop inside the API process.
 *
 * Same fallback reasoning `exceptions/runner.ts` gives: `haulq-worker` is
 * the intended home once it is deployed, but it is not deployed yet, so
 * this is what actually runs in production today.
 *
 * Off by default, like every other poller in this codebase — and for a
 * sharper reason than usual. A poller that starts itself in every test
 * and every local `pnpm dev` is an annoyance; this one composes messages
 * addressed to real brokers. `AUTOPILOT_POLL_MS=0` is the second lock,
 * behind the carrier's own opt-in, behind the kill switch.
 */

import type { FastifyInstance } from 'fastify';
import { runDeliveredToPaidPass } from './delivered-to-paid.ts';

export interface AutopilotRunnerOptions {
  intervalMs: number;
}

export function startAutopilotRunner(app: FastifyInstance, options: AutopilotRunnerOptions): void {
  if (options.intervalMs <= 0) {
    app.log.info({}, 'autopilot disabled (AUTOPILOT_POLL_MS is 0)');
    return;
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
    app.log.info({ intervalMs: options.intervalMs }, 'autopilot loop started');
    while (!stopping) {
      try {
        const summary = await runDeliveredToPaidPass({
          db: app.db,
          // Read on every pass, not captured once: the client is decorated
          // after this starts, and a test or a redeploy can replace it.
          deps: { unipile: app.unipileClient, storage: app.storage, log: app.log },
          log: app.log,
        });
        // Silent when there is nothing to say, same reasoning as the
        // exception scan: "0 recorded" forever buries the lines that matter.
        if (summary.recorded > 0 || Object.keys(summary.skipped).length > 0) {
          app.log.info(summary, 'autopilot pass');
        }
      } catch (err) {
        app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'autopilot pass failed');
      }
      if (stopping) break;
      await pause(options.intervalMs);
    }
    app.log.info({}, 'autopilot loop stopped');
  })();

  app.addHook('onClose', async () => {
    stopping = true;
    wake?.();
    await finished;
  });
}
