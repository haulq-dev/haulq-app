#!/usr/bin/env node
/**
 * Put outbox messages that ran out of retries back in the queue.
 *
 * The manual step `replayOutboxMessage`'s note describes: fix the cause, then
 * replay. First needed on 2026-09-30, when HaulQ's Azure Document
 * Intelligence subscription ran out of trial credit. Every photo uploaded
 * meanwhile failed its eight reads within a few minutes and was parked.
 *
 * Run from Render → haulq-api → Shell, which has the production
 * DATABASE_URL (the database accepts no outside connections):
 *
 *   node --experimental-strip-types apps/api/src/scripts/replay-dead-letters.ts
 *       lists what is parked, changes nothing
 *   node --experimental-strip-types apps/api/src/scripts/replay-dead-letters.ts document.received --replay
 *       puts every parked message of that topic back in the queue
 *
 * Listing first, replaying only with `--replay` and a topic: a replay re-runs
 * real work (an OCR read is paid, an email is sent), so it is never the
 * default and never "everything".
 */

import { closeDatabase, createDatabase, outboxDeadLetters, replayOutboxMessage } from '@haulq/db';
import { loadEnv } from '../env.ts';

async function main() {
  const env = loadEnv();
  const db = createDatabase({ url: env.DATABASE_URL });
  const topic = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const replay = process.argv.includes('--replay');

  try {
    const parked = (await outboxDeadLetters(db, { limit: 500 })).filter((m) => !topic || m.topic === topic);

    if (parked.length === 0) {
      console.log(topic ? `Nothing parked for ${topic}.` : 'Nothing parked.');
      return;
    }

    for (const m of parked) {
      console.log(
        `${m.seq}  ${m.topic}  ${m.createdAt.toISOString()}  attempts=${m.attempts}  ${(m.lastError ?? '').slice(0, 100)}`,
      );
    }

    if (!replay) {
      console.log(`\n${parked.length} parked. Nothing changed. To re-queue one topic, add it and --replay.`);
      return;
    }
    if (!topic) {
      console.log('\nName a topic to replay (e.g. document.received). Replaying everything at once is refused.');
      process.exitCode = 1;
      return;
    }

    for (const m of parked) await replayOutboxMessage(db, m.seq);
    console.log(`\nRe-queued ${parked.length} ${topic} message(s). The outbox picks them up within seconds.`);
  } finally {
    await closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
