/**
 * The outbox worker.
 *
 * A second process whose only job is to drain `event_outbox`. It exists because
 * of Azure: an OCR pass takes seconds per page and polls a remote operation
 * while it waits, and doing that inside the API means one carrier's forty-page
 * packet is something every other carrier feels. Phase 1 plan section 5 called
 * this the moment to split, and the drain logic lived in `@haulq/db` from the
 * start precisely so the split would be an entry point rather than a rewrite.
 *
 * ---------------------------------------------------------------------------
 * It builds its dependencies exactly the way the API does
 * ---------------------------------------------------------------------------
 *
 * Through `runtime.ts`, not through its own copies. The worker reads objects the
 * API wrote; if one of them resolves storage to R2 and the other to the local
 * disk, every document uploaded becomes invisible to the process meant to
 * extract it, and the only symptom is documents that sit at `received` forever.
 * One implementation, called twice.
 *
 * ---------------------------------------------------------------------------
 * No HTTP server
 * ---------------------------------------------------------------------------
 *
 * Render background workers are not health-checked over HTTP, so there is
 * nothing to listen on. Liveness is the process being alive; Render restarts it
 * if it exits. What that costs is the ability to ask it anything, so the boot
 * log states the whole configuration — which readers, which mailer, which
 * store — because that log line is the only interface this process has.
 *
 * ---------------------------------------------------------------------------
 * Running more than one is safe
 * ---------------------------------------------------------------------------
 *
 * `drainOutbox` claims with `FOR UPDATE SKIP LOCKED`, so two workers take
 * disjoint sets rather than double-sending. Scaling out is a Render slider.
 */

import { closeDatabase, createDatabase, ping } from '@haulq/db';
import pino from 'pino';
import { loadEnv } from './env.ts';
import { buildOutboxGroups } from './outbox/handlers.ts';
import { startOutboxLoop } from './outbox/loop.ts';
import { buildDocumentReader, buildMailer, buildStorage } from './runtime.ts';

const env = loadEnv();

const log = pino({
  level: env.LOG_LEVEL,
  base: { service: 'haulq-worker' },
});

/**
 * How often to poll when there is nothing to do.
 *
 * Its own variable rather than `OUTBOX_POLL_MS`, so one Doppler config drives
 * both services correctly: the API sets `OUTBOX_POLL_MS=0` to keep slow work out
 * of the request process, and this still runs. Sharing the name would mean the
 * value that switches the API off also switches the worker off, which is a
 * config that silently stops all mail and all document reading.
 *
 * A full batch skips the wait entirely — see the loop.
 */
const intervalMs = Number(process.env['WORKER_POLL_MS'] ?? 2000);

const db = createDatabase({ url: env.DATABASE_URL, max: 5 });

// Fail loudly at boot rather than logging a connection error every two seconds
// forever. A worker that cannot reach the database has nothing to offer, and
// Render's restart is a better response than a process that looks alive.
try {
  await ping(db);
} catch (error) {
  log.error(
    { err: error instanceof Error ? error.message : String(error) },
    'worker cannot reach the database',
  );
  process.exit(1);
}

const storage = buildStorage(env, log);
const reader = buildDocumentReader(env, log);
const mailer = buildMailer(env, log);

const loop = startOutboxLoop({
  db,
  groups: buildOutboxGroups({
    mailer,
    webOrigin: env.WEB_ORIGIN,
    db,
    storage,
    reader,
    log,
  }),
  intervalMs,
  log,
});

log.info(
  { intervalMs, store: storage.name, reader: reader.name },
  'haulq-worker ready',
);

/**
 * Shut down by finishing the current pass.
 *
 * Render sends SIGTERM on every deploy. Killing a handler mid-flight leaves its
 * message leased until the lease expires, and it is then redelivered — correct,
 * because delivery is at-least-once, but it means paying Azure a second time to
 * read a page that was already read. Waiting costs a few seconds of deploy time.
 *
 * The second signal is not ignored: an operator who sends SIGTERM twice wants it
 * gone now, and refusing that is how a deploy hangs.
 */
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) {
      log.warn({ signal }, 'second signal — exiting without finishing the pass');
      process.exit(1);
    }
    stopping = true;
    log.info({ signal }, 'stopping after the current pass');

    void loop
      .stop()
      .then(() => closeDatabase(db))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log.error(
          { err: error instanceof Error ? error.message : String(error) },
          'error while shutting down',
        );
        process.exit(1);
      });
  });
}

await loop.finished;
