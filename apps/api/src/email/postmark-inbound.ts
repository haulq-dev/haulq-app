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
   * Set only for content referenced from the HTML body — a signature logo, a
   * tracking pixel — via `cid:`. A genuine attachment never carries one, which
   * is the whole filter the route needs to skip inline images.
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
  Attachments: z.array(PostmarkAttachmentSchema).optional().default([]),
});
export type PostmarkInboundPayload = z.infer<typeof PostmarkInboundSchema>;
