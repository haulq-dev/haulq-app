/**
 * Postmark's inbound webhook payload.
 *
 * Only the fields the route reads. Postmark's actual payload carries dozens —
 * headers, a parsed HTML/text body, `Cc`, `ReplyTo` — none of which HaulQ Docs
 * has a use for yet. Kept here rather than in `@haulq/contracts` because it is
 * a vendor's wire shape, not HaulQ's: `apps/web` never sees it, and the
 * contracts package is specifically the shape `apps/api` and `apps/web` agree
 * on.
 */

import { z } from 'zod';

export const PostmarkAttachmentSchema = z.object({
  Name: z.string(),
  /** Base64. Postmark inlines attachment bytes directly in the JSON payload. */
  Content: z.string(),
  ContentType: z.string(),
  ContentLength: z.number().int().nonnegative(),
  /**
   * Set for content Postmark's parser noticed *could* be referenced from the
   * HTML body via `cid:` — a signature logo, a tracking pixel. **Presence
   * alone does not mean it is.** Gmail stamps a `ContentID` on every
   * attachment part, inline or not — confirmed against a real send: a plain
   * PDF attachment came through with a `ContentID` and an `HtmlBody` that
   * never mentions it. The route has to check whether the body actually
   * contains `cid:{ContentID}` before treating this as inline; the field by
   * itself is not the filter.
   */
  ContentID: z.string().nullable().optional(),
});
export type PostmarkAttachment = z.infer<typeof PostmarkAttachmentSchema>;

export const PostmarkInboundSchema = z.object({
  From: z.string(),
  FromFull: z.object({ Email: z.string(), Name: z.string().optional() }).optional(),
  Subject: z.string().optional(),
  /** Postmark's own id for the message. The intake trace back to the mailbox. */
  MessageID: z.string(),
  /**
   * The `+tag` part of a plus-addressed recipient, e.g. `abc123` from
   * `docs+abc123@docs.haulq.ai`. Empty string when the address carried no tag.
   * This is how one shared inbound address routes to a tenant.
   */
  MailboxHash: z.string().optional().default(''),
  /** What an inline attachment's `cid:` would actually be referenced from. */
  HtmlBody: z.string().optional().default(''),
  Attachments: z.array(PostmarkAttachmentSchema).optional().default([]),
});
export type PostmarkInboundPayload = z.infer<typeof PostmarkInboundSchema>;
