/**
 * Postmark inbound webhook — email intake for HaulQ Docs.
 *
 * A carrier (or a broker, forwarded) sends a rate confirmation or a POD to
 * `docs+{org-slug}@docs.haulq.ai`. Postmark parses the MIME message and posts
 * this route one JSON payload per delivery; `MailboxHash` carries the
 * `{org-slug}` part — Postmark's plus-addressing convention — which is how a
 * single shared inbound address resolves to a tenant with no new schema:
 * `orgs.slug` is already unique.
 *
 * Verified with HTTP Basic Auth rather than a signature, because Postmark's
 * inbound parse webhook has none — see `auth/basic-auth.ts`.
 *
 * Each attachment goes through the same three moves `POST /v1/documents`
 * does — hash first, dedupe on `(org_id, sha256)`, store, then
 * `document.received` — so a broker's rate confirmation forwarded four times
 * costs one row and, after the first, zero writes to R2. Everything
 * downstream (classification, extraction, validation, the Azure fallback)
 * already runs off `document.received`; this route's only job is getting the
 * bytes into that event.
 */

import { randomUUID } from 'node:crypto';
import {
  createDocument,
  DocumentError,
  findDocumentBySha,
  getOrgBySlug,
  key as storageKey,
  scope,
  sha256,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { BasicAuthError, verifyBasicAuth } from '../auth/basic-auth.ts';
import { safeFilename, sniff } from '../documents/sniff.ts';
import { PostmarkInboundSchema } from '../email/postmark-inbound.ts';
import { HttpError } from '../plugins/request-context.ts';

/** Same ceiling as a direct upload — see documents.ts for why. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function postmarkInboundRoutes(app: FastifyInstance) {
  app.post('/v1/webhooks/postmark-inbound', async (request, reply) => {
    const user = app.env.POSTMARK_INBOUND_USER;
    const password = app.env.POSTMARK_INBOUND_PASSWORD;
    if (!user || !password) {
      // Refused rather than accepted-unverified — same posture as the Clerk
      // webhook. An endpoint that writes documents with no check is an
      // unauthenticated write reachable by anyone who learns the URL.
      throw new HttpError(
        503,
        'webhooks_not_configured',
        'Webhooks are not configured on this deployment.',
      );
    }

    try {
      verifyBasicAuth(request.headers.authorization, user, password);
    } catch (err) {
      if (err instanceof BasicAuthError) {
        request.log.warn({ err: err.message }, 'rejected postmark inbound webhook');
        throw new HttpError(401, 'invalid_credentials', err.explanation);
      }
      throw err;
    }

    const parsed = PostmarkInboundSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        'That is not a Postmark inbound payload HaulQ recognizes.',
      );
    }
    const payload = parsed.data;

    const slug = payload.MailboxHash.trim();
    const org = slug ? await getOrgBySlug(app.db, slug) : undefined;
    if (!org) {
      // 200, not 4xx: Postmark retries a non-2xx delivery, and mail sent to an
      // address with no matching org will never gain one by being retried.
      request.log.warn({ mailboxHash: slug, from: payload.From }, 'no org for inbound mail');
      return reply.code(200).send({ handled: false, reason: 'unknown mailbox' });
    }

    const s = scope(app.db, {
      orgId: org.id,
      actor: { type: 'integration', provider: 'postmark-inbound' },
      // A fresh id, same as every other route — this ties together the events
      // *this request* produces. Postmark's MessageID is not a UUID and is not
      // what correlationId is for; it is carried separately as
      // intakeMessageId, which is what traces a document back to the mailbox.
      correlationId: randomUUID(),
    });

    const results: Array<{ filename: string; documentId: string; deduped: boolean }> = [];

    for (const attachment of payload.Attachments) {
      // Referenced from the HTML body — a signature logo, a tracking pixel —
      // not something the sender attached. A real attachment never has one.
      if (attachment.ContentID) continue;

      let body: Buffer;
      try {
        body = Buffer.from(attachment.Content, 'base64');
      } catch {
        continue;
      }
      if (body.byteLength === 0 || body.byteLength > MAX_ATTACHMENT_BYTES) continue;

      // The bytes decide, same as a direct upload — Postmark's ContentType is
      // a claim, and a mail client mislabels attachments as often as a browser.
      const contentType = sniff(body);
      if (!contentType) continue;

      const digest = sha256(body);
      const already = await findDocumentBySha(s, digest);
      if (already) {
        results.push({ filename: attachment.Name, documentId: already.id, deduped: true });
        continue;
      }

      const id = randomUUID();
      const filename = safeFilename(attachment.Name, 'attachment');
      const objectKey = storageKey({ orgId: org.id, kind: 'documents', id, filename });
      await app.storage.put(objectKey, body, contentType);

      try {
        const { document, deduped } = await createDocument(s, {
          storageKey: objectKey,
          sha256: digest,
          source: 'email_intake',
          contentType,
          filename,
          byteSize: body.byteLength,
          receivedFrom: payload.FromFull?.Email ?? payload.From,
          intakeMessageId: payload.MessageID,
        });

        if (deduped) {
          // Lost a race with a concurrent delivery of the same bytes — Postmark
          // redelivering the same message concurrently, most likely.
          await app.storage.delete(objectKey).catch((err: unknown) => {
            request.log.warn({ err, key: objectKey }, 'could not remove a deduped inbound attachment');
          });
        }
        results.push({ filename: attachment.Name, documentId: document.id, deduped });
      } catch (err) {
        await app.storage.delete(objectKey).catch(() => {});

        if (err instanceof DocumentError) {
          // A rule this attachment breaks, not infrastructure — retrying the
          // whole message would fail the same way again. Skip it and keep
          // going; the rest of the message's attachments may be fine.
          request.log.warn(
            { err: err.explanation, filename: attachment.Name },
            'inbound attachment rejected',
          );
          continue;
        }
        // Unexpected — storage or the database is in trouble. Let this throw
        // to a 500 so Postmark retries the whole message; dedupe makes that
        // free for whatever already made it in.
        throw err;
      }
    }

    return reply.code(200).send({ handled: true, org: org.slug, documents: results });
  });
}
