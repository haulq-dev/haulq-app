/**
 * Refuses to run the test suite against anything but a local database.
 *
 * The `test` scripts in `packages/db` and `apps/api` run it twice. First
 * they run it on its own, so a bad URL fails once with one message before
 * the runner starts. Then they preload it with `--import`, which Node's test
 * runner applies to each test file's subprocess, not the runner itself. That
 * second run is a backstop: no test file loads without passing it. Both scripts also pass
 * `--env-file-if-exists=../../.env`, and a developer's `.env` can hold
 * production's `DATABASE_URL`. `haulq-app/.env` did, on 2026-09-23. So a
 * plain `pnpm test`, with no local `DATABASE_URL` exported first, used to
 * point every suite at production. The suites create orgs and delete them
 * again, the delete step disables the event log's append-only triggers to do
 * it, and a run that crashes midway leaves its orgs behind. When this guard
 * was added, production held about fifty orgs with test-suite names ("Photo
 * Co", "Nosy Co", ...).
 *
 * Local means the host is loopback, which covers `docker-compose.test.yml`
 * (localhost:5434) and CI's service container (localhost:5432). An unset
 * `DATABASE_URL` is fine: every database suite already skips itself then.
 *
 * `HAULQ_ALLOW_REMOTE_TEST_DB=1` overrides this, for a deliberately
 * disposable remote database. The name is long on purpose.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function testDatabaseProblem(env: NodeJS.ProcessEnv): string | null {
  const url = env['DATABASE_URL'];
  if (!url || env['HAULQ_ALLOW_REMOTE_TEST_DB'] === '1') return null;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'DATABASE_URL is not a valid URL, so the test suite cannot tell whether it is local.';
  }

  if (LOCAL_HOSTS.has(host)) return null;

  return [
    `Refusing to run tests against DATABASE_URL host "${host}". Tests only run against a local database.`,
    'Start the test database and point at it first:',
    '  docker compose -f docker-compose.test.yml up -d --wait',
    '  export DATABASE_URL=postgres://haulq:haulq@localhost:5434/haulq',
    'Your .env may hold a remote DATABASE_URL; an exported one takes precedence over it.',
    'For a deliberately disposable remote database, set HAULQ_ALLOW_REMOTE_TEST_DB=1.',
  ].join('\n');
}

const problem = testDatabaseProblem(process.env);
if (problem) {
  console.error(problem);
  process.exit(1);
}
