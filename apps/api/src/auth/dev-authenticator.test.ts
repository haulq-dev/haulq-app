/**
 * The dev authenticator.
 *
 * The first test is the one that matters. A header-trusting authenticator
 * reachable from the internet is a complete authorization bypass — anyone could
 * name any tenant — and the only reliable defence is that it cannot be
 * constructed in production at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthenticationError } from './authenticator.ts';
import { DevAuthenticator } from './dev-authenticator.ts';

const ORG = '11111111-2222-3333-4444-555555555555';
const USER = '66666666-7777-8888-9999-000000000000';

describe('DevAuthenticator', () => {
  it('refuses to exist in production', () => {
    assert.throws(() => new DevAuthenticator('production'), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Refusing to start/);
      // The message must name the settings to change. Whoever reads it is
      // looking at a deploy log, not this file — and getting that wrong cost
      // three deploy cycles once already.
      assert.match(err.message, /AUTH_PROVIDER=clerk/);
      assert.match(err.message, /CLERK_SECRET_KEY/);
      return true;
    });
  });

  it('builds in development and test', () => {
    assert.ok(new DevAuthenticator('development'));
    assert.ok(new DevAuthenticator('test'));
  });

  const auth = new DevAuthenticator('test');

  it('returns null when no tenant is named', async () => {
    // Null, not a throw. "No credential" and "broken credential" are different
    // situations and deserve different status codes.
    assert.equal(await auth.authenticate({}), null);
  });

  it('resolves a user actor', async () => {
    const result = await auth.authenticate({
      'x-haulq-org-id': ORG,
      'x-haulq-user-id': USER,
    });
    assert.equal(result?.orgId, ORG);
    assert.equal(result?.actor.type, 'user');
    assert.equal(result?.role, 'owner', 'defaults to owner');
  });

  it('resolves an agent actor distinctly from a user', async () => {
    // Guardrail 5 needs to be exercisable locally. If the stub could only
    // produce user actors, no agent path would ever be tested before Clerk.
    const result = await auth.authenticate({
      'x-haulq-org-id': ORG,
      'x-haulq-agent': 'claude-haiku-4-5-20251001',
      'x-haulq-user-id': USER,
    });
    assert.equal(result?.actor.type, 'agent');
    if (result?.actor.type === 'agent') {
      assert.equal(result.actor.model, 'claude-haiku-4-5-20251001');
      assert.equal(result.actor.onBehalfOfUserId, USER);
    }
  });

  it('insists every request names an actor', async () => {
    // No anonymous mode, deliberately. Code written against an implicit actor
    // is code that has to be found and fixed when auth lands.
    await assert.rejects(
      auth.authenticate({ 'x-haulq-org-id': ORG }),
      (err: unknown) =>
        err instanceof AuthenticationError && /must name who is acting/.test(err.explanation),
    );
  });

  /**
   * Asserts on `explanation`, not `message`.
   *
   * The two are deliberately different: `message` is the short technical one
   * that goes to logs, `explanation` is the sentence a person reads. Testing
   * the wrong one passes while the user-facing half rots.
   */
  const rejectsWithExplanation = async (p: Promise<unknown>, pattern: RegExp) =>
    assert.rejects(
      p,
      (err: unknown) =>
        err instanceof AuthenticationError && pattern.test(err.explanation),
    );

  it('rejects a malformed org id', async () => {
    await rejectsWithExplanation(
      auth.authenticate({ 'x-haulq-org-id': 'not-a-uuid', 'x-haulq-user-id': USER }),
      /not a valid uuid/,
    );
  });

  it('rejects an unknown role', async () => {
    await rejectsWithExplanation(
      auth.authenticate({
        'x-haulq-org-id': ORG,
        'x-haulq-user-id': USER,
        'x-haulq-role': 'superadmin',
      }),
      /is not a role/,
    );
  });

  it('keeps the log message and the user explanation separate', async () => {
    await assert.rejects(
      auth.authenticate({ 'x-haulq-org-id': 'nope', 'x-haulq-user-id': USER }),
      (err: unknown) => {
        assert.ok(err instanceof AuthenticationError);
        assert.notEqual(
          err.message,
          err.explanation,
          'a technical message should not be shown to a carrier',
        );
        return true;
      },
    );
  });
});
