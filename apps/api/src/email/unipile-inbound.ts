/**
 * Unipile's two webhook payloads this codebase consumes.
 *
 * Kept here rather than in `@haulq/contracts` for the same reason
 * `postmark-inbound.ts` keeps Postmark's shape local: this is a vendor's
 * wire shape, not HaulQ's, and `apps/web` never sees either payload.
 *
 * `UnipileAttachmentSchema`'s `id` is the only field this file trusts —
 * everything else (`name`, `mime_type`) is inferred from Unipile's general
 * object shape rather than confirmed against a captured webhook delivery,
 * since this codebase has no Unipile account yet. Same caveat `unipile.ts`'s
 * own module note carries: validate against a real delivery before this
 * reaches a carrier's inbox. `sniff()` in `unipile-inbound.ts` (the route,
 * not this file) reads the actual bytes for content type regardless, the
 * same "the bytes decide" discipline `postmark-inbound.ts` already applies
 * to a mail client's claimed `ContentType`.
 */

import { z } from 'zod';

/**
 * The hosted-auth flow's server-to-server confirmation, posted to whatever
 * `notify_url` HaulQ registered when it created the link —
 * `developer.unipile.com/docs/hosted-auth`.
 */
export const UnipileAccountNotifySchema = z.object({
  status: z.string(),
  account_id: z.string().optional(),
  /** The org id HaulQ passed as `name` when requesting the link — how this callback correlates back to a tenant with no state-signing of HaulQ's own. */
  name: z.string().optional(),
});
export type UnipileAccountNotifyPayload = z.infer<typeof UnipileAccountNotifySchema>;

export const UnipileAttachmentSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  mime_type: z.string().optional(),
});

/**
 * `developer.unipile.com/docs/new-emails-webhook` — real-time notification
 * of a received, sent or moved email. HaulQ only acts on `mail_received`
 * with attachments; everything else is read and ignored, not rejected —
 * an unrecognized `event` value should not fail the whole delivery, since
 * Unipile controls that enum and this codebase does not.
 */
export const UnipileNewEmailWebhookSchema = z.object({
  email_id: z.string(),
  account_id: z.string(),
  event: z.string(),
  subject: z.string().optional().default(''),
  from_attendee: z.object({ identifier: z.string().optional() }).optional(),
  has_attachments: z.boolean().optional().default(false),
  attachments: z.array(UnipileAttachmentSchema).optional().default([]),
});
export type UnipileNewEmailWebhookPayload = z.infer<typeof UnipileNewEmailWebhookSchema>;
