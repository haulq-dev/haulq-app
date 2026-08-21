/**
 * What each outbox topic does.
 *
 * The consumer in `@haulq/db` knows how to claim, retry and give up. It knows
 * nothing about email, and should not — this is where a topic meets the outside
 * world.
 *
 * A handler that throws is retried. A handler that returns is done. So the only
 * real decision in here is which failures are worth retrying, and the answer
 * comes from the mailer: a rejected recipient is permanent, a rate limit is not.
 */

import { randomUUID } from 'node:crypto';
import {
  eventSubject,
  scope,
  type Database,
  type ObjectStore,
  type OutboxHandler,
  type OutboxMessage,
} from '@haulq/db';
import { inviteEmail, type InvitePayload } from '../email/invite-email.ts';
import { MailerError, type Mailer } from '../email/postmark.ts';
import { processDocument } from '../documents/pipeline.ts';
import type { ModelDocumentReader } from '../documents/model-reader.ts';
import type { DocumentReader } from '../documents/reader.ts';

export interface HandlerDeps {
  mailer: Mailer;
  /** The app origin the invite link points at. */
  webOrigin: string;
  /** Needed by the document pipeline: the row says where the bytes are, not what they are. */
  db: Database;
  storage: ObjectStore;
  reader: DocumentReader;
  /** Unset means no model pass — see `documents/pipeline.ts`. */
  modelReader?: ModelDocumentReader | undefined;
  log: {
    info: (o: unknown, msg: string) => void;
    warn: (o: unknown, msg: string) => void;
  };
}

/** Enough of the payload to send, or nothing. */
function asInvite(message: OutboxMessage): InvitePayload | null {
  const p = message.payload as Partial<InvitePayload>;
  if (typeof p.email !== 'string' || typeof p.token !== 'string') return null;
  return {
    email: p.email,
    role: typeof p.role === 'string' ? p.role : 'driver',
    token: p.token,
    orgName: typeof p.orgName === 'string' ? p.orgName : 'your carrier',
    ...(typeof p.expiresAt === 'string' ? { expiresAt: p.expiresAt } : {}),
    ...(p.invitedByEmail ? { invitedByEmail: p.invitedByEmail } : {}),
  };
}

function inviteHandler(deps: HandlerDeps): OutboxHandler {
  return async (message) => {
    const invite = asInvite(message);

    if (!invite) {
      /**
       * Returning, not throwing.
       *
       * A message with no token cannot ever be sent, so retrying it eight times
       * only delays the moment someone looks. The likeliest cause is benign:
       * `scrubPayloadOnSuccess` blanks the payload after a successful send, so
       * a row redelivered after its lease expired lands here having already
       * gone out. Treating that as failure would send nothing and shout about
       * it; treating it as done is correct in both cases.
       */
      deps.log.warn(
        { seq: message.seq.toString(), topic: message.topic },
        'invite email skipped: payload has no token (already sent, or scrubbed)',
      );
      return;
    }

    try {
      await deps.mailer.send({
        ...inviteEmail(invite, deps.webOrigin),
        metadata: { outboxSeq: message.seq.toString(), orgId: message.orgId },
      });
      deps.log.info(
        { seq: message.seq.toString(), to: invite.email },
        'invite email sent',
      );
    } catch (error) {
      if (error instanceof MailerError && !error.retryable) {
        // Permanent. The address is wrong or the recipient is suppressed, and
        // no amount of retrying fixes either. Swallowed so the message settles
        // rather than burning its budget, but logged at warn so it is findable
        // — the invitation itself is still valid and can be re-sent by hand.
        deps.log.warn(
          {
            seq: message.seq.toString(),
            to: invite.email,
            status: error.status,
            postmarkCode: error.postmarkCode,
          },
          'invite email permanently rejected — not retrying',
        );
        return;
      }
      throw error;
    }
  };
}

/**
 * Read a document that has just arrived.
 *
 * Off the request path on purpose. Even the cheap path inflates every stream in
 * a PDF, and the expensive path — once OCR and a model are wired in — takes
 * seconds per page. One carrier uploading a forty-page packet must not be
 * something another carrier feels.
 *
 * The actor is an **agent**, not the person who uploaded the file. Guardrail 5
 * turns on being able to ask "what did a model decide, and which one" months
 * later, and attributing a machine's reading to whoever happened to click
 * upload destroys exactly that. The reader's own version is the model
 * identifier, so a bad extractor is findable in the log by name.
 */
function documentHandler(deps: HandlerDeps): OutboxHandler {
  return async (message) => {
    // `subject_id` on the event is the document. The payload deliberately does
    // not repeat it — see the note on `eventSubject`.
    const lookup = scope(deps.db, {
      orgId: message.orgId,
      actor: { type: 'system', name: 'outbox-consumer' },
      correlationId: randomUUID(),
    });
    // `event_seq` is nullable: a row can be queued without a logged event. A
    // document read has no subject in that case, and no way to find one.
    const event = message.eventSeq
      ? await eventSubject(lookup, message.eventSeq)
      : undefined;

    if (!event?.subjectId) {
      // Cannot ever succeed, so returning rather than throwing. Retrying eight
      // times only delays the moment somebody looks at the log.
      deps.log.warn(
        { seq: message.seq.toString(), eventSeq: message.eventSeq?.toString() ?? null },
        'document.received has no subject — nothing to read',
      );
      return;
    }

    const documentId = event.subjectId;
    const s = scope(deps.db, {
      orgId: message.orgId,
      actor: { type: 'agent', model: deps.reader.name },
      // Same correlation as the upload that caused it, so the reading and the
      // request that triggered it are one thread in the log rather than two.
      correlationId: event.correlationId ?? randomUUID(),
    });

    const outcome = await processDocument(s, documentId, {
      reader: deps.reader,
      storage: deps.storage,
      modelReader: deps.modelReader,
    });

    const base = { seq: message.seq.toString(), documentId, reader: deps.reader.name };

    switch (outcome.status) {
      case 'skipped':
        deps.log.info({ ...base, why: outcome.why }, 'document not read');
        return;

      case 'needs':
        // Not a failure and not retryable: the rules did their job and declined.
        // It stays `received`, so it stays in the inbox as work to be done, and
        // it is the queue whatever OCR or model pass lands next will drain.
        deps.log.info(
          {
            ...base,
            needs: outcome.needs,
            ...(outcome.needs === 'model' ? { guess: outcome.guess?.kind ?? null } : {}),
          },
          `document needs ${outcome.needs}`,
        );
        return;

      case 'read':
        deps.log.info(
          {
            ...base,
            kind: outcome.classification.kind,
            confidence: outcome.classification.confidence,
            fields: outcome.fieldCount,
            missing: outcome.missing,
            validation:
              outcome.validation.status === 'validated'
                ? outcome.validation.verdict.outcome
                : `skipped:${outcome.validation.why}`,
          },
          'document read without a model call',
        );
        return;
    }
  };
}

/**
 * The topic map. Only topics in here are claimed; anything else stays queued
 * untouched.
 *
 * Kept as a flat map because that is what a test wants when it drains
 * everything in one go. Production drains through `buildOutboxGroups` below,
 * which splits it — see the note there, it is not a formality.
 */
export function buildOutboxHandlers(deps: HandlerDeps): Record<string, OutboxHandler> {
  return {
    'member.invite_email': inviteHandler(deps),
    'document.received': documentHandler(deps),
  };
}

/** One set of topics drained together, with a lease sized to fit them. */
export interface OutboxGroup {
  name: string;
  handlers: Record<string, OutboxHandler>;
  batchSize: number;
  leaseSeconds: number;
}

/**
 * Fast topics and slow topics cannot share a batch.
 *
 * `drainOutbox` stamps every message in a batch with the same lease at claim
 * time and then handles them **serially**. The lease is therefore a budget for
 * the whole batch, not for each message — which was invisible while every
 * handler finished in milliseconds, and stopped being invisible the moment OCR
 * entered the pipeline:
 *
 *     20 documents × 15s of OCR each = 300s = the entire default lease
 *
 * Past that line, messages still being processed become claimable again, so a
 * page gets read — and paid for — twice. Worse, `attempts` is incremented at
 * claim, so a slow batch burns retries against `maxAttempts` on documents that
 * were succeeding, and they eventually dead-letter for the crime of being slow.
 *
 * So the batch is sized against the worst case per message, and the lease is
 * sized against the batch:
 *
 *   invitations   Postmark answers in about a second. 20 × ~2s ≈ 40s, well
 *                 inside the default 300s lease. Unchanged.
 *
 *   documents     the worst case is `AzureDocumentReader`'s own 120s timeout,
 *                 because that is the point at which it gives up. 3 × 120s =
 *                 360s, so the lease is 900s — enough slack that a full batch
 *                 of forty-page scans still finishes inside it.
 *
 * The lease follows the timeout, not the other way round. Shrinking the Azure
 * budget to make the arithmetic tidier would make HaulQ abandon documents it
 * could have read.
 *
 * **Order matters.** Fast first, so a backlog of scanned history never delays
 * somebody's invitation email behind twenty minutes of OCR.
 */
export function buildOutboxGroups(deps: HandlerDeps): OutboxGroup[] {
  return [
    {
      name: 'fast',
      handlers: { 'member.invite_email': inviteHandler(deps) },
      batchSize: 20,
      leaseSeconds: 300,
    },
    {
      name: 'slow',
      handlers: { 'document.received': documentHandler(deps) },
      batchSize: 3,
      leaseSeconds: 900,
    },
  ];
}
