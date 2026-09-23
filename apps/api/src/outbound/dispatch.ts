/**
 * The outbound choke point. `FEATURE_REQUESTS_PLAN.md` section 8, piece 1.
 *
 * Every message HaulQ sends in a carrier's name goes through
 * `sendAsCarrier` or `approveOutbound`, and nothing else calls
 * `UnipileClient.sendEmail`. That is the whole design: the rules below live
 * in one place, so a new kind of message cannot forget one of them.
 *
 *  1. **The action must be registered.** Anything not in
 *     `OUTBOUND_ACTIONS` is refused — that is how "accept a rate" or
 *     "commit a truck" stay out of reach of any configuration.
 *  2. **The carrier's mode is held to the action's ceiling** — at send
 *     time, not just when the setting was written, so tightening a ceiling
 *     in code takes effect on messages already configured.
 *  3. **The kill switch and the connection are checked on every send.** A
 *     message that asked for more autonomy than it is allowed is recorded
 *     as `shadow` with a `holdReason`, not dropped and not sent.
 *  4. **Every message is stored verbatim before anything is sent.** A
 *     crash between "decided" and "sent" leaves a row that says what was
 *     about to happen.
 *  5. **A `dedupeKey` makes a repeated intent a no-op.** The autonomous
 *     loops re-evaluate every pass; this is what stops them chasing twice.
 *
 * A message stuck in `sending` (the process died mid-call) is never
 * retried automatically: the send may have succeeded, and a duplicate
 * email in a carrier's name is worse than one that needs a person to look.
 */

import {
  claimForSending,
  createOutbound,
  getMailboxConnection,
  getOutbound,
  getOutboundSettings,
  markOutboundFailed,
  markOutboundSent,
  rejectOutbound,
  type OutboundMessageRow,
  type Scope,
} from '@haulq/db';
import {
  clampMode,
  isOutboundAction,
  type OutboundHoldReason,
  type OutboundMode,
} from '@haulq/contracts';
import { z } from 'zod';
import { UnipileApiError, type UnipileClient } from '../integrations/unipile.ts';

export class OutboundError extends Error {
  readonly code: 'unknown_action' | 'invalid_message' | 'sending_disabled' | 'not_found' | 'wrong_state';
  constructor(code: OutboundError['code'], message: string) {
    super(message);
    this.name = 'OutboundError';
    this.code = code;
  }
}

export interface OutboundDeps {
  unipile: UnipileClient | undefined;
}

export interface OutboundInput {
  actionType: string;
  to: string[];
  subject: string;
  body: string;
  relatedType?: string | undefined;
  relatedId?: string | undefined;
  dedupeKey?: string | undefined;
  /** A prior message's provider id, to thread this as a reply. */
  replyToProviderId?: string | undefined;
}

const MAX_RECIPIENTS = 5;

const MessageSchema = z.object({
  to: z.array(z.string().email()).min(1).max(MAX_RECIPIENTS),
  // A newline in a subject is a header-injection attempt, not a subject.
  subject: z.string().min(1).max(200).regex(/^[^\r\n]+$/, 'subject must be a single line'),
  body: z.string().min(1).max(20_000),
});

export interface OutboundResult {
  message: OutboundMessageRow;
  /** True only when an email actually left in this call. */
  sent: boolean;
  /** False when `dedupeKey` matched an earlier message — nothing new was recorded or sent. */
  created: boolean;
}

/**
 * Decide, record and (if the mode allows) send. Never throws for a
 * provider failure — that is recorded on the row as `failed`, because the
 * caller is an unattended loop and the record is the deliverable. It does
 * throw `OutboundError` for a message that should never have been built.
 */
export async function sendAsCarrier(
  deps: OutboundDeps,
  s: Scope,
  input: OutboundInput,
): Promise<OutboundResult> {
  if (!isOutboundAction(input.actionType)) {
    throw new OutboundError('unknown_action', `"${input.actionType}" is not an action HaulQ may send.`);
  }
  const parsed = MessageSchema.safeParse({ to: input.to, subject: input.subject, body: input.body });
  if (!parsed.success) {
    throw new OutboundError('invalid_message', parsed.error.issues.map((i) => i.message).join('; '));
  }

  const [connection, settings] = await Promise.all([getMailboxConnection(s), getOutboundSettings(s)]);

  const requested = clampMode(input.actionType, (settings.modes[input.actionType] as OutboundMode | undefined) ?? 'shadow');

  let mode: OutboundMode = requested;
  let holdReason: OutboundHoldReason | null = null;
  if (requested !== 'shadow') {
    if (!connection || connection.status !== 'connected' || !deps.unipile) {
      mode = 'shadow';
      holdReason = 'not_connected';
    } else if (!settings.sendingEnabled) {
      mode = 'shadow';
      holdReason = 'sending_disabled';
    }
  }

  const { message, created } = await createOutbound(s, {
    actionType: input.actionType,
    mode,
    status: mode === 'act' ? 'sending' : mode === 'draft' ? 'pending_approval' : 'shadow',
    holdReason,
    toAddresses: parsed.data.to,
    subject: parsed.data.subject,
    body: parsed.data.body,
    relatedType: input.relatedType,
    relatedId: input.relatedId,
    dedupeKey: input.dedupeKey,
  });

  if (!created || mode !== 'act') return { message, sent: false, created };

  const finished = await performSend(deps, s, message, input.replyToProviderId);
  return { message: finished, sent: finished.status === 'sent', created };
}

/** A person approves a drafted message; it sends now. */
export async function approveOutbound(
  deps: OutboundDeps,
  s: Scope,
  id: string,
  userId: string,
): Promise<OutboundMessageRow> {
  const existing = await getOutbound(s, id);
  if (!existing) throw new OutboundError('not_found', 'That message no longer exists.');
  if (existing.status !== 'pending_approval') {
    throw new OutboundError('wrong_state', `That message is ${existing.status}, not waiting for approval.`);
  }

  // The kill switch is checked again here: an approval a day later must not
  // send if the owner has since turned sending off.
  const [connection, settings] = await Promise.all([getMailboxConnection(s), getOutboundSettings(s)]);
  if (!connection || connection.status !== 'connected' || !settings.sendingEnabled || !deps.unipile) {
    throw new OutboundError('sending_disabled', 'Sending is turned off, so nothing can be approved right now.');
  }

  const claimed = await claimForSending(s, id, 'pending_approval', userId);
  if (!claimed) throw new OutboundError('wrong_state', 'That message was already handled.');
  return performSend(deps, s, claimed);
}

export async function rejectDraft(s: Scope, id: string, userId: string): Promise<OutboundMessageRow> {
  const rejected = await rejectOutbound(s, id, userId);
  if (rejected) return rejected;
  const existing = await getOutbound(s, id);
  if (!existing) throw new OutboundError('not_found', 'That message no longer exists.');
  throw new OutboundError('wrong_state', `That message is ${existing.status}, not waiting for approval.`);
}

async function performSend(
  deps: OutboundDeps,
  s: Scope,
  message: OutboundMessageRow,
  replyToProviderId?: string,
): Promise<OutboundMessageRow> {
  const connection = await getMailboxConnection(s);
  if (!deps.unipile || !connection?.unipileAccountId) {
    return markOutboundFailed(s, message.id, 'No connected mailbox to send from.');
  }

  try {
    const { providerMessageId } = await deps.unipile.sendEmail({
      accountId: connection.unipileAccountId,
      to: message.toAddresses,
      subject: message.subject,
      body: message.body,
      replyToProviderId,
      // The message's own id: a retry of this exact send returns the
      // original result instead of emailing a second time.
      idempotencyKey: message.id,
    });
    return await markOutboundSent(s, message.id, providerMessageId);
  } catch (err) {
    if (err instanceof UnipileApiError) {
      return markOutboundFailed(s, message.id, err.message);
    }
    throw err;
  }
}

