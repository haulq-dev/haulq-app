/**
 * Who may see which control, and whether the carrier has paid. Answered once.
 *
 * Every rule here only decides whether to *show* a control. The API's
 * `requireRole` / `requireEntitlement` / subscription gate is what refuses.
 * These were inline in each web screen (`myRole === 'owner' || ...`); the
 * mobile app needs the same answers, so they live here now.
 */

import { ApiRequestError } from './client.ts';
import type { OrgPlan, OrgStatus } from './types.ts';

/** Loads, trucks, drivers, feasibility: the dispatch surface. */
export function canDispatch(role: string | undefined): boolean {
  return role === 'owner' || role === 'dispatcher';
}

/** Creating and sending invoices and packets. Matches `Pay.tsx`'s `canWrite`. */
export function canWritePay(role: string | undefined): boolean {
  return role === 'owner' || role === 'dispatcher' || role === 'accountant';
}

/** Recording payments, voiding, factoring: moving money. Matches `Pay.tsx`'s `canManageMoney`. */
export function canManageMoney(role: string | undefined): boolean {
  return role === 'owner' || role === 'accountant';
}

/** Connecting Motive, a mailbox, anything holding a credential. */
export function canManageIntegrations(role: string | undefined): boolean {
  return role === 'owner';
}

/**
 * Seeing what Autopilot drafted, and approving or rejecting it. Owner and
 * dispatcher see everything; an accountant sees invoices and reminders only
 * (the API narrows the list, this only decides whether to show the screen).
 */
export function canReviewOutbound(role: string | undefined): boolean {
  return role === 'owner' || role === 'dispatcher' || role === 'accountant';
}

/** Connecting the mailbox, the master switch, how freely each action may act. The owner's call alone. */
export function canConfigureOutbound(role: string | undefined): boolean {
  return role === 'owner';
}

/** Changing roles and removing people. Inviting is `canDispatch`. */
export function canManageMembers(role: string | undefined): boolean {
  return role === 'owner';
}

/**
 * Only a positive `active` counts as paid, the same rule `Shell.tsx` and the
 * API's `REQUIRE_ACTIVE_SUBSCRIPTION` gate apply. `past_due` is Stripe still
 * retrying a card; HaulQ blocks it anyway rather than extending credit.
 */
export function isSubscriptionActive(status: OrgStatus | undefined): boolean {
  return status === 'active';
}

/** Customer-facing plan names. `carrier` is the Stripe/DB id for what the site sells as Core. */
export const PLAN_LABEL: Record<OrgPlan, string> = {
  carrier: 'Core',
  fleet: 'Fleet',
};

export function planLabel(plan: OrgPlan | null | undefined): string {
  return plan ? PLAN_LABEL[plan] : 'No plan';
}

/**
 * The API refused because this org's plan doesn't include the product
 * (`requireEntitlement`, Track and Routes today).
 *
 * The API's own `explanation` for this reads "Contact hello@haulq.ai to
 * upgrade". That's fine on the web, but it is a purchase call to action
 * that the iOS app must not show (Guideline 3.1.1, see
 * MOBILE_PARITY_PLAN.md section 2). Callers on mobile check this and render
 * their own neutral text instead of `error.explanation`.
 */
export function isNotEntitled(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'not_entitled';
}

/** The API's own paywall answered (`REQUIRE_ACTIVE_SUBSCRIPTION`). Same caveat as `isNotEntitled`. */
export function isSubscriptionInactive(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'subscription_inactive';
}
