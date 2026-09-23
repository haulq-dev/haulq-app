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
  test: { label: 'Test message', maxMode: 'act' },
  /** Chasing a broker for a missing POD/BOL on a delivered load. */
  pod_chase: { label: 'Chase a missing POD', maxMode: 'act' },
  /**
   * Delivering an invoice for a delivered load with its documents in hand.
   *
   * Ceiling is `shadow` on purpose, for now: a broker or factor pays against
   * an invoice *and* the rate confirmation and POD, and outbound email
   * cannot carry attachments yet. Sending the invoice as body text alone
   * would put an incomplete submission in the carrier's name, so until
   * attachments exist the most this can do is show the owner exactly what
   * it would send — which is also the fastest way to find out whether the
   * amounts it derives are right. Raise this to `draft`/`act` in the same
   * change that adds attachments, not before.
   */
  invoice_delivery: { label: 'Send an invoice', maxMode: 'shadow' },
  /** A reminder on an invoice past due. */
  payment_reminder: { label: 'Payment reminder', maxMode: 'act' },
  /** Anything to a broker that is not routine — a person reads it first. */
  broker_message: { label: 'Message to a broker', maxMode: 'draft' },
  /** A detention claim: it asserts money owed, so it is never unattended. */
  detention_claim: { label: 'Detention claim', maxMode: 'draft' },
} as const satisfies Record<string, { label: string; maxMode: OutboundMode }>;

export type OutboundActionType = keyof typeof OUTBOUND_ACTIONS;

export const OutboundActionTypeSchema = z.enum(
  Object.keys(OUTBOUND_ACTIONS) as [OutboundActionType, ...OutboundActionType[]],
);

export const OutboundModeSchema = z.enum(OUTBOUND_MODES);

export function isOutboundAction(value: string): value is OutboundActionType {
  return Object.hasOwn(OUTBOUND_ACTIONS, value);
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

export const OutboundMessageSchema = z.object({
  id: z.string().uuid(),
  actionType: z.string(),
  mode: OutboundModeSchema,
  status: z.enum(OUTBOUND_STATUSES),
  holdReason: z.enum(OUTBOUND_HOLD_REASONS).nullable(),
  toAddresses: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  error: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

export const ListOutboundQuerySchema = z.object({
  status: z.enum(OUTBOUND_STATUSES).optional(),
});
