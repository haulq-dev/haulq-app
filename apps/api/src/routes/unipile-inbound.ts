/**
 * Unipile's two inbound webhooks — mailbox connect confirmation, and new
 * mail arriving at a connected mailbox.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 1. The `new-email` webhook is
 * deliberately not requested programmatically anywhere in this codebase —
 * Unipile's hosted-auth flow only creates the *account* connection; the
 * "new email" webhook subscription itself is one-time operator setup in
 * Unipile's own dashboard, the same way Postmark's inbound stream is
 * configured in Postmark's dashboard rather than by this codebase (see
 * `postmark-inbound.ts`'s module note). Whoever does that setup must append
 * `?secret={UNIPILE_WEBHOOK_SECRET}` to the URL they register, matching
 * `account-notify`'s own query param below — neither of Unipile's webhooks
 * carries a signature.
 *
 * `new-email`'s attachment handling mirrors `postmark-inbound.ts`'s three
 * moves — hash first, dedupe on `(org_id, sha256)`, store, then
 * `document.received` — but the byte-acquisition step is structurally
 * different: Postmark inlines attachment bytes as base64 in the webhook
 * body; Unipile's webhook carries attachment *metadata* only (confirmed:
 * `developer.unipile.com/docs/new-emails-webhook`'s own example shows an
 * `attachments` array with no byte content), so each one needs a follow-up
 * `fetchAttachment` call before there is anything to hash. That is
 * deliberately not folded into one shared helper with Postmark's loop —
 * forcing two different acquisition strategies through one abstraction
 * would cost more clarity than the ~15 duplicated lines are worth.
 *
 * **Unconfirmed against a real delivery**, same caveat `unipile.ts` and
 * `unipile-inbound.ts` (the schema file) both already carry: whether
 * Unipile's `attachments` array excludes inline signature images and
 * tracking pixels the way Postmark's does not (Postmark hands that
 * filtering to this codebase; Unipile, being a higher-level unified API,
 * plausibly already does it — but that is inference, not a confirmed fact).
 * Watch the first real deliveries before trusting this silently.
 */

import { randomUUID } from 'node:crypto';
import {
  createDocument,
  DocumentError,
  findDocumentBySha,
  getMailboxConnectionByAccountId,
  key as storageKey,
  markMailboxConnected,
  scope,
  sha256,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { safeFilename, sniff } from '../documents/sniff.ts';
import { UnipileAccountNotifySchema, UnipileNewEmailWebhookSchema } from '../email/unipile-inbound.ts';
import { UnipileApiError } from '../integrations/unipile.ts';
import { HttpError } from '../plugins/request-context.ts';

/** Same ceiling as a direct upload and Postmark's inbound path — see `documents.ts` for why. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const SecretQuerySchema = z.object({ secret: z.string().optional() });

function requireWebhookSecret(app: FastifyInstance, provided: string | undefined): void {
  const expected = app.env.UNIPILE_WEBHOOK_SECRET;
  if (!expected) {
    throw new HttpError(503, 'webhooks_not_configured', 'Unipile webhooks are not configured on this deployment.');
  }
  // Not constant-time — this guards a webhook URL, not a login form, and
  // every other shared-secret check in this codebase (Postmark's Basic
  // Auth included) makes the same trade for the same reason: the secret is
  // long, random, and never brute-forced online in the time a request
  // takes to time out.
  if (!provided || provided !== expected) {
    throw new HttpError(401, 'invalid_credentials', 'Missing or incorrect webhook secret.');
  }
}

export async function unipileInboundRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // `hide: true` on both — Unipile dictates these payload shapes, not
  // HaulQ, same reasoning `postmark-inbound.ts` gives for hiding its own.
  server.post(
    '/v1/webhooks/unipile/account-notify',
    { schema: { hide: true, querystring: SecretQuerySchema, body: UnipileAccountNotifySchema } },
    async (request, reply) => {
      requireWebhookSecret(app, request.query.secret);

      const { status, account_id, name } = request.body;
      // "CREATION_SUCCESS" for a first connect, "RECONNECTED" after the
      // account-holder resolves a credentials issue — `hosted-auth`'s own
      // documented statuses. Anything else (a denied/failed flow) is
      // acknowledged and dropped, not stored as a connection.
      if ((status !== 'CREATION_SUCCESS' && status !== 'RECONNECTED') || !account_id || !name) {
        request.log.info({ status, hasAccountId: Boolean(account_id) }, 'unipile account-notify: not a completed connection');
        return reply.code(200).send({ handled: false });
      }

      try {
        await markMailboxConnected(app.db, { orgId: name, unipileAccountId: account_id });
      } catch (err) {
        // The org's mailbox row does not exist — `connect` was never called
        // for this org, or it was torn down between the link being issued
        // and the carrier finishing it. Logged, not thrown: Unipile has no
        // reason to retry a delivery that will fail the same way twice.
        request.log.warn({ err: err instanceof Error ? err.message : String(err), orgId: name }, 'unipile account-notify: no pending connection to complete');
      }

      return reply.code(200).send({ handled: true });
    },
  );

  server.post(
    '/v1/webhooks/unipile/new-email',
    { schema: { hide: true, querystring: SecretQuerySchema, body: UnipileNewEmailWebhookSchema } },
    async (request, reply) => {
      requireWebhookSecret(app, request.query.secret);

      const payload = request.body;
      if (payload.event !== 'mail_received' || !payload.has_attachments || payload.attachments.length === 0) {
        return reply.code(200).send({ handled: false, reason: 'no attachments' });
      }

      const connection = await getMailboxConnectionByAccountId(app.db, payload.account_id);
      if (!connection) {
        // Same posture `postmark-inbound.ts` takes for mail to an unknown
        // mailbox hash: 200, not 4xx, since retrying will never make an
        // account_id gain a matching org.
        request.log.warn({ accountId: payload.account_id }, 'unipile new-email: no org for this account');
        return reply.code(200).send({ handled: false, reason: 'unknown account' });
      }

      if (!app.unipileClient) {
        throw new HttpError(503, 'not_configured', 'Unipile is not configured on this deployment yet.');
      }

      const s = scope(app.db, {
        orgId: connection.orgId,
        actor: { type: 'integration', provider: 'unipile-inbound' },
        correlationId: randomUUID(),
      });

      const results: Array<{ filename: string; documentId: string; deduped: boolean }> = [];

      for (const attachment of payload.attachments) {
        let body: Buffer;
        try {
          const fetched = await app.unipileClient.fetchAttachment(payload.email_id, payload.account_id, attachment.id);
          body = fetched.body;
        } catch (err) {
          if (err instanceof UnipileApiError) {
            request.log.warn({ err: err.message, attachmentId: attachment.id }, 'could not fetch a unipile attachment');
            continue;
          }
          throw err;
        }
        if (body.byteLength === 0 || body.byteLength > MAX_ATTACHMENT_BYTES) continue;

        // The bytes decide, same as a direct upload and Postmark's inbound
        // path — Unipile's `mime_type` is a claim, not a fact.
        const contentType = sniff(body);
        if (!contentType) continue;

        const digest = sha256(body);
        const already = await findDocumentBySha(s, digest);
        if (already) {
          results.push({ filename: attachment.name ?? 'attachment', documentId: already.id, deduped: true });
          continue;
        }

        const id = randomUUID();
        const filename = safeFilename(attachment.name ?? 'attachment', 'attachment');
        const objectKey = storageKey({ orgId: connection.orgId, kind: 'documents', id, filename });
        await app.storage.put(objectKey, body, contentType);

        try {
          const { document, deduped } = await createDocument(s, {
            storageKey: objectKey,
            sha256: digest,
            source: 'email_intake',
            contentType,
            filename,
            byteSize: body.byteLength,
            receivedFrom: payload.from_attendee?.identifier ?? 'unknown',
            intakeMessageId: payload.email_id,
          });

          if (deduped) {
            await app.storage.delete(objectKey).catch((err: unknown) => {
              request.log.warn({ err, key: objectKey }, 'could not remove a deduped unipile attachment');
            });
          }
          results.push({ filename, documentId: document.id, deduped });
        } catch (err) {
          await app.storage.delete(objectKey).catch(() => {});

          if (err instanceof DocumentError) {
            request.log.warn({ err: err.explanation, filename }, 'inbound unipile attachment rejected');
            continue;
          }
          throw err;
        }
      }

      return reply.code(200).send({ handled: true, org: connection.orgId, documents: results });
    },
  );
}
