/**
 * The nightly broker re-check loop.
 *
 * `findBrokersDueForRecheck`/`recordScheduledVerification` in `@haulq/db` do
 * the actual work; this is the scheduling around it — modelled directly on
 * `exceptions/scan-loop.ts`, which sweeps for the same kind of thing: a
 * cross-org condition worth raising an alert on. Deliberately its own small
 * loop rather than sharing code with that one, for the reason its own
 * comment already gives: the unit of work differs enough (a per-broker FMCSA
 * call here, a database-only sweep there) that forcing both through one
 * abstraction would make neither easy to read for the size either one is.
 */

import { findBrokersDueForRecheck, recordScheduledVerification, type Database } from '@haulq/db';
import { FmcsaError, lookupCarrier } from '../integrations/fmcsa.ts';
import type { RuntimeLog } from '../runtime.ts';

export interface VerifyRecheckLoopOptions {
  db: Database;
  /** Gap between sweeps. Must be > 0. */
  intervalMs: number;
  /** How stale a broker's last check has to be before this re-checks it. */
  staleHours: number;
  fmcsaWebKey: string;
  fmcsaBaseUrl?: string | undefined;
  log: RuntimeLog;
}

export interface VerifyRecheckLoop {
  readonly finished: Promise<void>;
  stop(): Promise<void>;
}

/**
 * One pass. Exported because it is the unit worth testing directly.
 *
 * One broker's FMCSA failure does not abort the sweep — a transient timeout
 * on broker 4 of 40 must not cost brokers 5 through 40 their re-check for
 * another `intervalMs`.
 */
export async function recheckOnce(options: {
  db: Database;
  staleHours: number;
  fmcsaWebKey: string;
  fmcsaBaseUrl?: string | undefined;
  log: RuntimeLog;
}): Promise<{ ok: boolean; checked: number; changed: number }> {
  try {
    const due = await findBrokersDueForRecheck(options.db, options.staleHours);

    let checked = 0;
    let changed = 0;

    for (const broker of due) {
      const query = broker.mcNumber ?? broker.usdotNumber;
      if (!query) continue;

      let result;
      try {
        result = options.fmcsaBaseUrl
          ? await lookupCarrier(query, options.fmcsaWebKey, options.fmcsaBaseUrl)
          : await lookupCarrier(query, options.fmcsaWebKey);
      } catch (error) {
        if (error instanceof FmcsaError) {
          options.log.warn(
            { brokerId: broker.brokerId, err: error.message },
            'verify recheck: FMCSA lookup failed for one broker',
          );
          continue;
        }
        throw error;
      }

      checked += 1;
      const { changed: didChange } = await recordScheduledVerification(options.db, {
        orgId: broker.orgId,
        brokerId: broker.brokerId,
        brokerName: broker.brokerName,
        source: 'FMCSA QCMobile',
        operatingStatus: result.operatingStatus,
        legalName: result.legalName,
        dbaName: result.dbaName,
        raw: result.raw,
        previousOperatingStatus: broker.previousOperatingStatus,
      });
      if (didChange) changed += 1;
    }

    // Silent when nothing changed, same reasoning as the exception scan:
    // this runs every few hours, and "0 changed" forever buries the lines
    // that matter.
    if (changed > 0) {
      options.log.info({ checked, changed, due: due.length }, 'verify recheck found status changes');
    }
    return { ok: true, checked, changed };
  } catch (error) {
    options.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'verify recheck failed',
    );
    return { ok: false, checked: 0, changed: 0 };
  }
}

export function startVerifyRecheckLoop(options: VerifyRecheckLoopOptions): VerifyRecheckLoop {
  if (options.intervalMs <= 0) {
    throw new Error(
      'startVerifyRecheckLoop needs a positive interval; use the caller to decide whether to run at all',
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
      { intervalMs: options.intervalMs, staleHours: options.staleHours },
      'verify recheck loop started',
    );

    while (!stopping) {
      await recheckOnce({
        db: options.db,
        staleHours: options.staleHours,
        fmcsaWebKey: options.fmcsaWebKey,
        fmcsaBaseUrl: options.fmcsaBaseUrl,
        log: options.log,
      });
      if (stopping) break;
      await pause(options.intervalMs);
    }

    options.log.info({}, 'verify recheck loop stopped');
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
