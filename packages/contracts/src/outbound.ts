/**
 * Outbound — what HaulQ may send in a carrier's name, and how freely.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 8. An agent with send access to a
 * carrier's mailbox is only acceptable with an explicit policy on what it
 * may do unattended, so every outbound message carries an *action type*,
 * and every action type has a *ceiling* on how autonomous it can ever be.
 * The carrier picks a mode per action type; the ceiling below is what no
 * configuration can raise.
 *
 * Three modes, in order of autonomy:
 *
 *  - `shadow`: decided and drafted, recorded, never sent. The default for
 *    everything — the carrier watches what would have gone out before
 *    trusting any of it.
 *  - `draft`: held for one-tap approval; sent only when a person approves.
 *  - `act`: sent immediately, recorded, the carrier told afterward.
 *
 * The plan's fourth tier, *Ask* (accept a rate, commit a truck, anything
 * that binds money or capacity), is not a mode: those actions are not in
 * this registry at all, so the choke point refuses them. Absence is the
 * guardrail — there is no configuration value that makes an unregistered
 * action sendable.
 */

import { z } from 'zod';

export const OUTBOUND_MODES = ['shadow', 'draft', 'act'] as const;
export type OutboundMode = (typeof OUTBOUND_MODES)[number];

const MODE_RANK: Record<OutboundMode, number> = { shadow: 0, draft: 1, act: 2 };

export const OUTBOUND_ACTIONS = {
  /** The owner sending themselves a message to prove the connection works. */
  test: { label: 'Test message', maxMode: 'act', available: false },
  /** Chasing a broker for a missing POD/BOL on a delivered load. */
  pod_chase: { label: 'Chase a missing POD', maxMode: 'act', available: false },
  /**
   * Delivering an invoice for a delivered load with its documents in hand.
   *
   * Ceiling is `draft`, not `act`: the invoice amount is the highest-stakes
   * number the loop derives, and an invoice email carries real attachments
   * now (the invoice PDF, the rate confirmation, the POD), so every one is
   * held for a person's approval. Raise to `act` only after a carrier has
   * seen enough approved invoices to trust the amounts it works out.
   */
  invoice_delivery: { label: 'Send an invoice', maxMode: 'draft', available: true },
  /** A reminder on an invoice past due. */
  payment_reminder: { label: 'Payment reminder', maxMode: 'act', available: true, expiresAfterDays: 7 },
  /** Anything to a broker that is not routine — a person reads it first. */
  broker_message: { label: 'Message to a broker', maxMode: 'draft', available: false },
  /** A detention claim: it asserts money owed, so it is never unattended. */
  detention_claim: { label: 'Detention claim', maxMode: 'draft', available: false },
} as const satisfies Record<
  string,
  { label: string; maxMode: OutboundMode; available: boolean; expiresAfterDays?: number }
>;

export type OutboundActionType = keyof typeof OUTBOUND_ACTIONS;

/**
 * The actions that are about money owed to the carrier — the ones an
 * accountant reviews. An accountant may see and approve these and nothing
 * else: a message to a broker about a load is a dispatcher's conversation.
 */
export const OUTBOUND_MONEY_ACTIONS: readonly OutboundActionType[] = ['invoice_delivery', 'payment_reminder', 'detention_claim'];

export const OutboundActionTypeSchema = z.enum(
  Object.keys(OUTBOUND_ACTIONS) as [OutboundActionType, ...OutboundActionType[]],
);

export const OutboundModeSchema = z.enum(OUTBOUND_MODES);

export function isOutboundAction(value: string): value is OutboundActionType {
  return Object.hasOwn(OUTBOUND_ACTIONS, value);
}

/**
 * How long a drafted message stays worth approving, or null if it never
 * goes stale. A payment reminder says "10 days overdue"; approved a month
 * later it would be wrong about a different invoice state entirely, so it
 * expires. An invoice for a delivered load does not — what it bills is a
 * snapshot that stays true.
 */
export function expiryDaysFor(action: OutboundActionType): number | null {
  return (OUTBOUND_ACTIONS[action] as { expiresAfterDays?: number }).expiresAfterDays ?? null;
}

/** The most autonomous mode an action type may ever run in. */
export function maxModeFor(action: OutboundActionType): OutboundMode {
  return OUTBOUND_ACTIONS[action].maxMode;
}

/** A requested mode, held to the action's ceiling. */
export function clampMode(action: OutboundActionType, requested: OutboundMode): OutboundMode {
  const max = maxModeFor(action);
  return MODE_RANK[requested] > MODE_RANK[max] ? max : requested;
}

export const OUTBOUND_STATUSES = [
  'shadow',
  'pending_approval',
  'sending',
  'sent',
  'failed',
  'rejected',
  'expired',
] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/** Why a message that asked for more autonomy was held back to shadow. */
export const OUTBOUND_HOLD_REASONS = ['sending_disabled', 'not_connected'] as const;
export type OutboundHoldReason = (typeof OUTBOUND_HOLD_REASONS)[number];

export const OutboundSettingsSchema = z.object({
  /** The kill switch, inverted: false means every message is held to shadow. */
  sendingEnabled: z.boolean(),
  /** Mode per action type. An action type with no entry runs in shadow. */
  modes: z.record(OutboundActionTypeSchema, OutboundModeSchema),
});
export type OutboundSettings = z.infer<typeof OutboundSettingsSchema>;

export const UpdateOutboundSettingsSchema = z.object({
  sendingEnabled: z.boolean().optional(),
  modes: z.record(OutboundActionTypeSchema, OutboundModeSchema).optional(),
});
export type UpdateOutboundSettings = z.infer<typeof UpdateOutboundSettingsSchema>;

// --- attachments ------------------------------------------------------------
//
// An attachment is a *reference*, resolved to bytes at the moment of sending —
// never carried on the message itself. That keeps every lookup inside the
// carrier's own scope (a reference to another carrier's document simply does
// not resolve) and means an invoice PDF is rendered from the invoice as it is
// when it goes out, not as it was when the message was drafted.

export const MAX_OUTBOUND_ATTACHMENTS = 5;
/** Combined size across one message. Gmail and Outlook both stop near 25 MB; this leaves headroom for encoding. */
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const OutboundAttachmentRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: z.string().uuid() }),
  z.object({ kind: z.literal('invoice'), invoiceId: z.string().uuid() }),
]);
export type OutboundAttachmentRef = z.infer<typeof OutboundAttachmentRefSchema>;

export const OutboundAttachmentInfoSchema = z.object({
  kind: z.enum(['document', 'invoice']),
  refId: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  /** Null for an invoice that has not been rendered yet — it is rendered when sent. */
  byteSize: z.number().int().nullable(),
});
export type OutboundAttachmentInfo = z.infer<typeof OutboundAttachmentInfoSchema>;

export const OutboundMessageSchema = z.object({
  id: z.string().uuid(),
  actionType: z.string(),
  mode: OutboundModeSchema,
  status: z.enum(OUTBOUND_STATUSES),
  holdReason: z.enum(OUTBOUND_HOLD_REASONS).nullable(),
  toAddresses: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(OutboundAttachmentInfoSchema),
  /** What this is about — 'load', 'broker' — so a screen can link to it. Null if nothing in particular. */
  relatedType: z.string().nullable(),
  relatedId: z.string().uuid().nullable(),
  /** A person's verdict on a preview: was this what they would have wanted sent? Null until someone looks. */
  verdict: z.enum(['right', 'wrong']).nullable(),
  verdictNote: z.string().nullable(),
  error: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

export const ListOutboundQuerySchema = z.object({
  status: z.enum(OUTBOUND_STATUSES).optional(),
});

// --- the settings response --------------------------------------------------

export const OutboundActionInfoSchema = z.object({
  type: OutboundActionTypeSchema,
  label: z.string(),
  maxMode: OutboundModeSchema,
  /** True only if a loop actually drives this today — the screen shows nothing else. */
  available: z.boolean(),
});
export type OutboundActionInfo = z.infer<typeof OutboundActionInfoSchema>;

export const OutboundSettingsResponseSchema = z.object({
  /** The kill switch, as it stands. False means every message is held. */
  sendingEnabled: z.boolean(),
  /**
   * Whether the loop that produces messages is running on this deployment at
   * all. It is off unless the server sets `AUTOPILOT_POLL_MS`; without this a
   * carrier could configure everything perfectly and nothing would happen.
   */
  autopilotRunning: z.boolean(),
  /** What each action *effectively* runs as: unset reads as `shadow`, and a stored value above the ceiling reads as the ceiling. */
  modes: z.record(OutboundActionTypeSchema, OutboundModeSchema),
  /**
   * Only the actions the carrier has explicitly set. An action absent here is
   * **off** — the loop does not visit a carrier for it at all, which is not
   * the same as `shadow` (recorded, never sent). `modes` cannot tell those two
   * apart; this can.
   */
  configured: z.record(OutboundActionTypeSchema, OutboundModeSchema),
  actions: z.array(OutboundActionInfoSchema),
});
export type OutboundSettingsResponse = z.infer<typeof OutboundSettingsResponseSchema>;

// --- evidence ----------------------------------------------------------------------
//
// `FEATURE_REQUESTS_PLAN.md` section 8 says an action moves from preview to
// approval to automatic on the carrier's own evidence. This is that evidence:
// their marks on previews, and what they did with drafts held for approval.

export const OUTBOUND_VERDICTS = ['right', 'wrong'] as const;
export type OutboundVerdict = (typeof OUTBOUND_VERDICTS)[number];

export const MarkOutboundSchema = z.object({
  verdict: z.enum(OUTBOUND_VERDICTS),
  /** Why it was wrong, in the reviewer's words. Optional; a short sentence is the point. */
  note: z.string().trim().max(500).optional(),
});
export type MarkOutbound = z.infer<typeof MarkOutboundSchema>;

/**
 * How much history is enough to *offer* a step up. Never applied for the
 * carrier: the screen shows the count and the carrier makes the change.
 *
 *  - `rightPreviews`: previews marked right before offering to ask first.
 *  - `approvals`: drafts approved before offering to send automatically.
 *  - `window`: how many of the latest verdicts (or decisions) must be clean.
 *    One old mistake should not block a step up forever, and one new one
 *    should hold it back.
 */
export const PROMOTION_EVIDENCE = { rightPreviews: 5, approvals: 10, window: 10 } as const;

export const OutboundEvidenceSchema = z.object({
  previewRight: z.number().int(),
  previewWrong: z.number().int(),
  /** Previews still sitting there with no verdict. */
  previewUnmarked: z.number().int(),
  /** Wrong marks among the latest `PROMOTION_EVIDENCE.window` marked previews. */
  recentPreviewWrong: z.number().int(),
  /** Drafts a person approved. */
  approved: z.number().int(),
  /** Drafts a person rejected. */
  rejected: z.number().int(),
  /** Rejections among the latest `PROMOTION_EVIDENCE.window` decisions. */
  recentRejected: z.number().int(),
});
export type OutboundEvidence = z.infer<typeof OutboundEvidenceSchema>;

export const OutboundEvidenceResponseSchema = z.object({
  /** Only actions with any history at all appear. */
  actions: z.record(z.string(), OutboundEvidenceSchema),
});
export type OutboundEvidenceResponse = z.infer<typeof OutboundEvidenceResponseSchema>;
