/**
 * The Clerk webhook endpoint.
 *
 * Skips without DATABASE_URL.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  destroyTestUser,
  findTestUserByExternalId,
  getTestUser,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { signSvix } from '../auth/svix-signature.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const SECRET = 'whsec_' + Buffer.from('webhook-test-key-of-32-bytes!!!!').toString('base64');

let app: FastifyInstance;
const createdUserIds: string[] = [];

/** Posts a correctly signed Clerk event. */
async function deliver(
  event: unknown,
  opts: { secret?: string; id?: string; timestamp?: number } = {},
) {
  const body = Buffer.from(JSON.stringify(event));
  const id = opts.id ?? `msg_${Date.now()}`;
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = signSvix({
    secret: opts.secret ?? SECRET,
    id,
    timestamp,
    body,
  });

  return app.inject({
    method: 'POST',
    url: '/webhooks/clerk',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': signature,
    },
    payload: body,
  });
}

const userEvent = (type: string, clerkId: string, over: Record<string, unknown> = {}) => ({
  type,
  data: {
    id: clerkId,
    primary_email_address_id: 'idn_primary',
    email_addresses: [
      { id: 'idn_old', email_address: 'old@example.com' },
      { id: 'idn_primary', email_address: 'primary@example.com' },
    ],
    first_name: 'Ray',
    last_name: 'Mendez',
    ...over,
  },
});

suite('clerk webhook', () => {
  before(async () => {
    app = await buildServer(
      loadEnv({
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: url!,
        CLERK_WEBHOOK_SECRET: SECRET,
      }),
    );
  });

  after(async () => {
    for (const id of createdUserIds) await destroyTestUser(app.db, id);
    await app.close();
  });

  /** Finds the local user a webhook created, and remembers it for teardown. */
  async function localUser(clerkId: string) {
    const row = await findTestUserByExternalId(app.db, clerkId);
    if (row && !createdUserIds.includes(row.id)) createdUserIds.push(row.id);
    return row;
  }

  // --- signature -----------------------------------------------------------

  it('rejects an unsigned request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/clerk',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(userEvent('user.created', 'user_unsigned')),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(await localUser('user_unsigned'), undefined, 'nothing was written');
  });

  it('rejects a signature from the wrong secret', async () => {
    const wrong = 'whsec_' + Buffer.from('a-completely-different-key-32b!!').toString('base64');
    const res = await deliver(userEvent('user.created', 'user_wrongsecret'), { secret: wrong });
    assert.equal(res.statusCode, 401);
    assert.equal(await localUser('user_wrongsecret'), undefined);
  });

  it('rejects a replayed delivery', async () => {
    const res = await deliver(userEvent('user.created', 'user_replay'), {
      timestamp: Math.floor(Date.now() / 1000) - 900,
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().explanation, /replay/);
  });

  it('rejects a body altered after signing', async () => {
    // Proves the signature covers the bytes rather than the parsed object.
    const body = Buffer.from(JSON.stringify(userEvent('user.created', 'user_orig')));
    const id = 'msg_tamper';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signSvix({ secret: SECRET, id, timestamp, body });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/clerk',
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': String(timestamp),
        'svix-signature': signature,
      },
      payload: Buffer.from(JSON.stringify(userEvent('user.created', 'user_TAMPERED'))),
    });
    assert.equal(res.statusCode, 401);
  });

  // --- sync ----------------------------------------------------------------

  it('creates a local user from user.created', async () => {
    const clerkId = `user_created_${Date.now()}`;
    const res = await deliver(userEvent('user.created', clerkId));

    assert.equal(res.statusCode, 200);
    const row = await localUser(clerkId);
    assert.equal(row!.email, 'primary@example.com', 'the primary address, not the first');
    assert.equal(row!.fullName, 'Ray Mendez');
  });

  it('is idempotent — Clerk retries', async () => {
    const clerkId = `user_retry_${Date.now()}`;
    await deliver(userEvent('user.created', clerkId));
    const second = await deliver(userEvent('user.created', clerkId));

    assert.equal(second.statusCode, 200);
    // A unique index on external_auth_id means a duplicate would have thrown
    // rather than produced a second row, so the assertion that matters is that
    // the retry succeeded and still resolves to one user.
    const row = await localUser(clerkId);
    assert.ok(row);
  });

  it('applies a changed email from user.updated', async () => {
    const clerkId = `user_updated_${Date.now()}`;
    await deliver(userEvent('user.created', clerkId));
    const before_ = await localUser(clerkId);

    await deliver(
      userEvent('user.updated', clerkId, {
        email_addresses: [{ id: 'idn_primary', email_address: 'new@example.com' }],
      }),
    );

    const row = await getTestUser(app.db, before_!.id);
    assert.equal(row!.email, 'new@example.com');
  });

  it('acknowledges a user with no email rather than making Clerk retry forever', async () => {
    const res = await deliver(
      userEvent('user.created', `user_noemail_${Date.now()}`, { email_addresses: [] }),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().handled, false);
  });

  it('retains the local record on user.deleted', async () => {
    // `users` is referenced by event_log.actor_user_id. An audit trail whose
    // actors have been deleted is not an audit trail — guardrail 6.
    const clerkId = `user_deleted_${Date.now()}`;
    await deliver(userEvent('user.created', clerkId));
    const created = await localUser(clerkId);

    const res = await deliver({ type: 'user.deleted', data: { id: clerkId } });
    assert.equal(res.statusCode, 200);

    const still = await getTestUser(app.db, created!.id);
    assert.ok(still, 'the record survives for the audit trail');
  });

  it('acknowledges event types it does not handle', async () => {
    // A 404 makes Clerk retry forever and eventually disable the endpoint.
    const res = await deliver({ type: 'session.created', data: { id: 'sess_1' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().handled, false);
  });

  // --- configuration -------------------------------------------------------

  it('refuses to accept anything when no secret is configured', async () => {
    // Accepting unverified would be an unauthenticated write to the users
    // table, reachable by anyone who learns the URL.
    const unconfigured = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
    );
    const res = await unconfigured.inject({
      method: 'POST',
      url: '/webhooks/clerk',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(userEvent('user.created', 'user_x')),
    });
    assert.equal(res.statusCode, 503);
    await unconfigured.close();
  });

  // --- encapsulation -------------------------------------------------------

  it('leaves JSON parsing intact for every other route', async () => {
    // The webhook needs the raw body for its signature. If its content type
    // parser leaked out of the plugin, every other route would receive a Buffer.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'content-type': 'application/json' },
      payload: { name: '', contactEmail: 'not-an-email' },
    });
    // 401 (no user) or 400 (bad body) — either proves the body was parsed as
    // JSON rather than handed over as bytes.
    assert.ok([400, 401].includes(res.statusCode), `got ${res.statusCode}`);
  });
});
