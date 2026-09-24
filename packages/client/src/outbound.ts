/**
 * Autopilot: what the review screen shows and says. Pure functions and copy,
 * no React, so web and mobile read the same words and the same rules.
 * `FEATURE_REQUESTS_PLAN.md` section 9. The hooks that fetch this are in
 * `react.ts`.
 *
 * **The copy rule.** A carrier never sees "shadow", "draft" or "act". Those
 * are the server's names for how much freedom an action has; the words here
 * describe what happens *to the carrier*: they are shown a message first,
 * asked before it goes, or it just goes.
 */

import {
  isOutboundAction,
  OUTBOUND_ACTIONS,
  type OutboundActionInfo,
  type OutboundMessage,
  type OutboundMode,
  type OutboundSettingsResponse,
} from '@haulq/contracts';

export type {
  OutboundActionInfo,
  OutboundActionType,
  OutboundAttachmentInfo,
  OutboundMessage,
  OutboundMode,
  OutboundSettingsResponse,
  OutboundStatus,
} from '@haulq/contracts';

/** `GET /v1/mailbox`. `status` is 'not_connected' when this org has never started. */
export interface MailboxStatus {
  connected: boolean;
  status: 'not_connected' | 'pending' | 'connected' | 'disconnected';
  provider: string | null;
  connectedAt: string | null;
}

// --- the per-action control ---------------------------------------------------

/**
 * The four positions of the one control per action. `off` is not a mode: it
 * means the carrier has set nothing, which the loop reads as "do not even
 * prepare this".
 */
export type ActionPosition = 'off' | 'preview' | 'ask' | 'auto';

export const ACTION_POSITIONS: ReadonlyArray<{ value: ActionPosition; label: string; help: string; mode: OutboundMode | null }> = [
  { value: 'off', label: 'Off', help: 'Nothing is prepared.', mode: null },
  { value: 'preview', label: 'Show me first', help: 'It writes each message but sends nothing. You see what it would have sent.', mode: 'shadow' },
  { value: 'ask', label: 'Ask me first', help: 'It writes each message and waits for your OK.', mode: 'draft' },
  { value: 'auto', label: 'Send automatically', help: 'It sends, and tells you afterward.', mode: 'act' },
];

const RANK: Record<OutboundMode, number> = { shadow: 0, draft: 1, act: 2 };

export function modeForPosition(position: ActionPosition): OutboundMode | null {
  return ACTION_POSITIONS.find((p) => p.value === position)?.mode ?? null;
}

/** Which position the carrier has chosen. Absent from `configured` is off, never a preview. */
export function positionFor(settings: Pick<OutboundSettingsResponse, 'configured'>, actionType: string): ActionPosition {
  const mode = (settings.configured as Record<string, OutboundMode | undefined>)[actionType];
  if (!mode) return 'off';
  return ACTION_POSITIONS.find((p) => p.mode === mode)?.value ?? 'off';
}

/** A position above the action's ceiling cannot be chosen, and says why. */
export function positionAllowed(action: Pick<OutboundActionInfo, 'maxMode'>, position: ActionPosition): { allowed: true } | { allowed: false; reason: string } {
  const mode = modeForPosition(position);
  if (mode === null || RANK[mode] <= RANK[action.maxMode]) return { allowed: true };
  return {
    allowed: false,
    reason: action.maxMode === 'draft' ? 'This always needs your OK before it goes out.' : 'This can only ever be a preview.',
  };
}

/** What each action does, in a sentence a carrier would say. Keyed by registry action type. */
export const ACTION_COPY: Record<string, { title: string; blurb: string }> = {
  invoice_delivery: {
    title: 'Invoice emails',
    blurb: 'When a load is delivered and the paperwork is in, it writes the invoice email to the broker with the invoice, rate confirmation and proof of delivery attached.',
  },
  payment_reminder: {
    title: 'Payment reminders',
    blurb: 'When a broker is a few days late paying, it writes one polite reminder listing what is owed, at most once a week per broker.',
  },
};

export function actionTitle(actionType: string): string {
  return ACTION_COPY[actionType]?.title ?? (isOutboundAction(actionType) ? OUTBOUND_ACTIONS[actionType].label : actionType);
}

// --- messages -----------------------------------------------------------------

export type ReviewTab = 'approve' | 'preview' | 'sent' | 'problems' | 'settings';

export const REVIEW_TAB_LABEL: Record<ReviewTab, string> = {
  approve: 'Needs your OK',
  preview: 'Would have sent',
  sent: 'Sent',
  problems: 'Problems',
  settings: 'Settings',
};

/** Which tab a message lives on. */
export function tabFor(message: Pick<OutboundMessage, 'status'>): Exclude<ReviewTab, 'settings'> {
  switch (message.status) {
    case 'pending_approval':
      return 'approve';
    case 'shadow':
      return 'preview';
    case 'sending':
    case 'sent':
      return 'sent';
    case 'failed':
    case 'rejected':
    case 'expired':
      return 'problems';
  }
}

export function groupMessages(messages: readonly OutboundMessage[]): Record<Exclude<ReviewTab, 'settings'>, OutboundMessage[]> {
  const groups: Record<Exclude<ReviewTab, 'settings'>, OutboundMessage[]> = { approve: [], preview: [], sent: [], problems: [] };
  for (const m of messages) groups[tabFor(m)].push(m);
  return groups;
}

/** Why a message that was only recorded was not sent. */
export function previewReason(message: Pick<OutboundMessage, 'holdReason'>): string {
  switch (message.holdReason) {
    case 'sending_disabled':
      return 'Held because sending from your mailbox is switched off.';
    case 'not_connected':
      return 'Held because no mailbox is connected.';
    default:
      return 'A preview: you asked to see these before anything is sent.';
  }
}

/** What went wrong, or what happened, for a message on the Problems tab. */
export function problemReason(message: Pick<OutboundMessage, 'status' | 'error'>): string {
  switch (message.status) {
    case 'failed':
      return message.error ?? 'It could not be sent.';
    case 'rejected':
      return 'You rejected this message, so it was not sent.';
    case 'expired':
      return 'It went out of date before anyone approved it, so it was withdrawn.';
    default:
      return '';
  }
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function messageAge(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Where an attachment's bytes come from. Both need the tenant header, so they are fetched, not linked. */
export function attachmentPath(attachment: Pick<OutboundMessage['attachments'][number], 'kind' | 'refId'>): string {
  return attachment.kind === 'invoice' ? `/v1/invoices/${attachment.refId}/pdf` : `/v1/documents/${attachment.refId}/content`;
}

/** What a message is about, in words. Null when it is about nothing in particular. */
export function relatedLabel(message: Pick<OutboundMessage, 'relatedType'>): string | null {
  if (message.relatedType === 'load') return 'About a load';
  if (message.relatedType === 'broker') return 'About a broker';
  return null;
}

// --- first run ------------------------------------------------------------------

export interface FirstRunStep {
  key: 'mailbox' | 'choose' | 'review';
  label: string;
  done: boolean;
}

/** The three-step checklist shown until it is done. */
export function firstRunSteps(input: {
  mailbox: Pick<MailboxStatus, 'connected'> | undefined;
  settings: Pick<OutboundSettingsResponse, 'configured' | 'actions'> | undefined;
  messages: readonly OutboundMessage[];
}): FirstRunStep[] {
  const available = input.settings?.actions.filter((a) => a.available) ?? [];
  const chosen = available.length > 0 && available.every((a) => positionFor(input.settings!, a.type) !== 'off');
  return [
    { key: 'mailbox', label: 'Connect your mailbox', done: input.mailbox?.connected === true },
    { key: 'choose', label: 'Choose how each kind of message is handled — “Show me first” is the safe start', done: chosen },
    { key: 'review', label: 'Look over the first messages it writes', done: input.messages.length > 0 },
  ];
}

/**
 * Which tab to open on. Waiting approvals come first, because that is the
 * screen's job; someone just back from connecting a mailbox, or with nothing
 * set up yet, goes to Settings.
 */
export function defaultTab(input: { pending: number; settings: Pick<OutboundSettingsResponse, 'configured'> | undefined; returningFromMailbox: boolean; canConfigure: boolean }): ReviewTab {
  if (input.pending > 0) return 'approve';
  if (input.canConfigure && (input.returningFromMailbox || (input.settings && Object.keys(input.settings.configured).length === 0))) return 'settings';
  return 'approve';
}
