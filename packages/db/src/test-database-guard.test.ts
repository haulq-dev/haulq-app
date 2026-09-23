import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// Importing runs the guard against this process's own env too. That is fine:
// the runner already preloaded it, so getting this far means the env passed.
import { testDatabaseProblem } from './test-database-guard.ts';

describe('testDatabaseProblem', () => {
  it('allows loopback hosts and an unset URL', () => {
    assert.equal(testDatabaseProblem({}), null);
    for (const host of ['localhost:5434', '127.0.0.1:5432', '[::1]:5432']) {
      assert.equal(testDatabaseProblem({ DATABASE_URL: `postgres://haulq:haulq@${host}/haulq` }), null, host);
    }
  });

  it('refuses a remote host, naming it', () => {
    const problem = testDatabaseProblem({
      DATABASE_URL: 'postgres://u:p@dpg-example-a.ohio-postgres.render.com/haulq',
    });
    assert.match(problem ?? '', /dpg-example-a\.ohio-postgres\.render\.com/);
  });

  it('refuses a URL it cannot parse rather than guessing', () => {
    assert.ok(testDatabaseProblem({ DATABASE_URL: 'not a url' }));
  });

  it('allows a remote host only with the explicit override', () => {
    const env = { DATABASE_URL: 'postgres://u:p@db.example.invalid/haulq' };
    assert.ok(testDatabaseProblem(env));
    assert.equal(testDatabaseProblem({ ...env, HAULQ_ALLOW_REMOTE_TEST_DB: '1' }), null);
  });
});
