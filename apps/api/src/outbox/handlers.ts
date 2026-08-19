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

import type { OutboxHandler, OutboxMessage } from '@haulq/db';
import { inviteEmail, type InvitePayload } from '../email/invite-email.ts';
import { MailerError, type Mailer } from '../email/postmark.ts';

export interface HandlerDeps {
  mailer: Mailer;
  /** The app origin the invite link points at. */
  webOrigin: string;
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
 * The topic map the runner drains.
 *
 * Only topics in here are claimed. Anything else stays queued untouched, which
 * is what lets `document.received` accumulate now and be picked up by whatever
 * handles it later — see the note in `@haulq/db`'s outbox module.
 */
export function buildOutboxHandlers(deps: HandlerDeps): Record<string, OutboxHandler> {
  return {
    'member.invite_email': inviteHandler(deps),
  };
}
