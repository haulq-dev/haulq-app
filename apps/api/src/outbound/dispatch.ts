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
 *  6. **A message that promises an attachment never goes out without it.**
 *     Attachments are references, resolved through the carrier's own scope
 *     when drafted and read from storage only at the moment of sending,
 *     where a file that is missing, rejected, or no longer matches its
 *     recorded checksum fails the whole message. An invoice email with no
 *     invoice on it is worse than no email.
 *
 * A message stuck in `sending` (the process died mid-call) is never
 * retried automatically: the send may have succeeded, and a duplicate
 * email in a carrier's name is worse than one that needs a person to look.
 */

import {
  annotateOutbound,
  claimForSending,
  createOutbound,
  getDocument,
  getInvoiceRenderFacts,
  getMailboxConnection,
  getOutbound,
  getOutboundSettings,
  markOutboundFailed,
  markOutboundSent,
  PayError,
  rejectOutbound,
  sendInvoice,
  sha256,
  type ObjectStore,
  type OutboundMessageRow,
  type Scope,
  type StoredOutboundAttachment,
} from '@haulq/db';
import {
  clampMode,
  isOutboundAction,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENTS,
  type OutboundActionType,
  type OutboundAttachmentRef,
  type OutboundHoldReason,
  type OutboundMode,
} from '@haulq/contracts';
import { z } from 'zod';
import { safeFilename } from '../documents/sniff.ts';
import { renderInvoicePdf } from '../invoices/pdf.ts';
import { UnipileApiError, type UnipileClient } from '../integrations/unipile.ts';
import type { RuntimeLog } from '../runtime.ts';

export class OutboundError extends Error {
  readonly code:
    | 'unknown_action'
    | 'invalid_message'
    | 'invalid_attachment'
    | 'sending_disabled'
    | 'not_found'
    | 'wrong_state';
  constructor(code: OutboundError['code'], message: string) {
    super(message);
    this.name = 'OutboundError';
    this.code = code;
  }
}

export interface OutboundDeps {
  unipile: UnipileClient | undefined;
  /** Where documents live. Read only at send time. */
  storage: ObjectStore;
  log?: RuntimeLog | undefined;
}

export interface OutboundInput {
  actionType: string;
  to: string[];
  subject: string;
  body: string;
  /** Documents and invoices to attach, by reference. */
  attachments?: OutboundAttachmentRef[] | undefined;
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

/** The same rule the choke point applies, so a caller can check *before* doing something it cannot undo. */
export const isDeliverableAddress = (address: string): boolean => z.string().email().safeParse(address).success;

export interface OutboundResult {
  message: OutboundMessageRow;
  /** True only when an email actually left in this call. */
  sent: boolean;
  /** False when `dedupeKey` matched an earlier message — nothing new was recorded or sent. */
  created: boolean;
}

/**
 * What a message would actually run as, given the ceiling, the connection
 * and the kill switch. Exported so a loop can ask *before* it does anything
 * with a side effect — the invoice loop creates a draft invoice only when
 * the email it belongs to will not be shadow.
 */
export async function resolveOutboundMode(
  deps: OutboundDeps,
  s: Scope,
  actionType: OutboundActionType,
): Promise<{ mode: OutboundMode; holdReason: OutboundHoldReason | null }> {
  const [connection, settings] = await Promise.all([getMailboxConnection(s), getOutboundSettings(s)]);
  const requested = clampMode(actionType, (settings.modes[actionType] as OutboundMode | undefined) ?? 'shadow');

  if (requested !== 'shadow') {
    if (!connection || connection.status !== 'connected' || !deps.unipile) {
      return { mode: 'shadow', holdReason: 'not_connected' };
    }
    if (!settings.sendingEnabled) return { mode: 'shadow', holdReason: 'sending_disabled' };
  }
  return { mode: requested, holdReason: null };
}

/**
 * Turn references into a recorded description of what will be attached,
 * refusing anything that does not resolve *in this carrier's scope*.
 * No bytes are read here — a draft only needs to say what it will carry.
 */
async function describeAttachments(
  s: Scope,
  refs: OutboundAttachmentRef[] | undefined,
): Promise<StoredOutboundAttachment[]> {
  if (!refs || refs.length === 0) return [];
  if (refs.length > MAX_OUTBOUND_ATTACHMENTS) {
    throw new OutboundError('invalid_attachment', `A message can carry at most ${MAX_OUTBOUND_ATTACHMENTS} attachments.`);
  }

  const out: StoredOutboundAttachment[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const id = ref.kind === 'document' ? ref.documentId : ref.invoiceId;
    if (seen.has(`${ref.kind}:${id}`)) continue;
    seen.add(`${ref.kind}:${id}`);

    if (ref.kind === 'document') {
      const doc = await getDocument(s, ref.documentId);
      if (!doc) throw new OutboundError('invalid_attachment', 'A document to attach does not exist.');
      if (doc.status === 'rejected' || doc.status === 'quarantined') {
        throw new OutboundError('invalid_attachment', `A ${doc.status} document cannot be attached.`);
      }
      out.push({
        kind: 'document',
        refId: doc.id,
        filename: safeFilename(doc.filename ?? `${doc.kind}.pdf`, 'document.pdf'),
        contentType: doc.contentType ?? 'application/octet-stream',
        byteSize: doc.byteSize ?? null,
        sha256: doc.sha256,
      });
    } else {
      const facts = await getInvoiceRenderFacts(s, ref.invoiceId);
      if (!facts) throw new OutboundError('invalid_attachment', 'An invoice to attach does not exist.');
      if (facts.status === 'void') throw new OutboundError('invalid_attachment', 'A void invoice cannot be attached.');
      out.push({
        kind: 'invoice',
        refId: facts.invoiceId,
        filename: `Invoice-${facts.reference}.pdf`,
        contentType: 'application/pdf',
        byteSize: null,
        sha256: null,
      });
    }
  }
  return out;
}

type LoadedAttachments =
  | { ok: true; files: Array<{ filename: string; contentType: string; body: Buffer }>; sent: StoredOutboundAttachment[] }
  | { ok: false; error: string };

/**
 * Read every attachment's bytes, at the moment of sending. Any failure —
 * gone, rejected since it was drafted, unreadable, or not the bytes that
 * were recorded — fails the whole message. See rule 6 in the module note.
 */
async function loadAttachments(
  deps: OutboundDeps,
  s: Scope,
  stored: StoredOutboundAttachment[],
): Promise<LoadedAttachments> {
  const files: Array<{ filename: string; contentType: string; body: Buffer }> = [];
  const sent: StoredOutboundAttachment[] = [];
  let total = 0;

  for (const a of stored) {
    let body: Buffer;
    if (a.kind === 'document') {
      const doc = await getDocument(s, a.refId);
      if (!doc || doc.status === 'rejected' || doc.status === 'quarantined') {
        return { ok: false, error: `${a.filename} is no longer available to attach, so the message was not sent.` };
      }
      try {
        body = await deps.storage.get(doc.storageKey);
      } catch {
        return { ok: false, error: `${a.filename} could not be read from storage, so the message was not sent.` };
      }
      if (sha256(body) !== doc.sha256) {
        return { ok: false, error: `${a.filename} does not match its recorded checksum, so the message was not sent.` };
      }
    } else {
      const facts = await getInvoiceRenderFacts(s, a.refId);
      if (!facts || facts.status === 'void') {
        return { ok: false, error: `${a.filename} is no longer valid to attach, so the message was not sent.` };
      }
      body = await renderInvoicePdf(facts);
    }

    total += body.byteLength;
    if (total > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      return { ok: false, error: 'The attachments are too large to send in one email, so the message was not sent.' };
    }
    files.push({ filename: a.filename, contentType: a.contentType, body });
    sent.push({ ...a, byteSize: body.byteLength, sha256: sha256(body) });
  }
  return { ok: true, files, sent };
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

  const attachments = await describeAttachments(s, input.attachments);
  const { mode, holdReason } = await resolveOutboundMode(deps, s, input.actionType);

  const { message, created } = await createOutbound(s, {
    actionType: input.actionType,
    mode,
    status: mode === 'act' ? 'sending' : mode === 'draft' ? 'pending_approval' : 'shadow',
    holdReason,
    toAddresses: parsed.data.to,
    subject: parsed.data.subject,
    body: parsed.data.body,
    attachments,
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

  const loaded = await loadAttachments(deps, s, message.attachments ?? []);
  if (!loaded.ok) return markOutboundFailed(s, message.id, loaded.error);

  let sent: OutboundMessageRow;
  try {
    const { providerMessageId } = await deps.unipile.sendEmail({
      accountId: connection.unipileAccountId,
      to: message.toAddresses,
      subject: message.subject,
      body: message.body,
      replyToProviderId,
      attachments: loaded.files.length > 0 ? loaded.files : undefined,
      // The message's own id: a retry of this exact send returns the
      // original result instead of emailing a second time.
      idempotencyKey: message.id,
    });
    sent = await markOutboundSent(s, message.id, providerMessageId, loaded.sent.length > 0 ? loaded.sent : undefined);
  } catch (err) {
    if (err instanceof UnipileApiError) {
      return markOutboundFailed(s, message.id, err.message);
    }
    throw err;
  }

  return afterSent(deps, s, sent);
}

/**
 * What must follow a send that actually went out. Today: an invoice email
 * marks its invoice sent, which is the thing `sendInvoice` always meant —
 * "hand it to the broker" — and could not do before, because nothing
 * delivered it.
 *
 * Failure here does **not** change the message: the email is a fact and
 * must never read as a failure a retry could act on. It is noted on the
 * message and logged, and the invoice stays a draft a person can send.
 */
async function afterSent(deps: OutboundDeps, s: Scope, message: OutboundMessageRow): Promise<OutboundMessageRow> {
  if (message.actionType !== 'invoice_delivery') return message;
  const invoice = message.attachments.find((a) => a.kind === 'invoice');
  if (!invoice) return message;

  try {
    await sendInvoice(s, invoice.refId);
    return message;
  } catch (err) {
    // Already sent by someone in the meantime — the goal is met.
    if (err instanceof PayError && err.code === 'not_draft') return message;

    const note = `The email went out, but the invoice could not be marked sent: ${err instanceof Error ? err.message : String(err)}`;
    deps.log?.warn({ messageId: message.id, invoiceId: invoice.refId, err: note }, 'invoice email sent but invoice not marked sent');
    await annotateOutbound(s, message.id, note);
    return (await getOutbound(s, message.id)) ?? message;
  }
}
