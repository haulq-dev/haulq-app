/**
 * Stripe Billing.
 *
 * Deliberately narrow: creating a Checkout Session for the Carrier Core plan,
 * and turning a webhook event into the status/plan writes `routes/webhooks.ts`
 * makes to `orgs` (`activateSubscriptionForOrg`, `applySubscriptionUpdate` in
 * `repositories/orgs.ts`). Everything else — dunning, invoice PDFs, proration
 * on an upgrade — is Stripe's own Checkout and Customer Portal, not
 * reimplemented here.
 *
 * `orgs.status` is the access gate the web app reads (`Shell.tsx`), and it
 * already had the right shape for this before Billing existed — `trialing`,
 * `active`, `past_due`, `paused`, `cancelled` — so subscription state maps
 * onto it directly rather than growing a parallel `subscriptionStatus`
 * column. `trialing` here means "no subscription yet", not a free trial:
 * `createOrg` sets it and nothing currently moves an org off it except this
 * webhook.
 */

import Stripe from 'stripe';

export type PlanKey = 'carrier';

/** What `runtime.ts`'s `buildBilling` decorates the app with. */
export interface BillingClient {
  client: Stripe;
  priceIds: Record<PlanKey, string>;
}

/**
 * One instance per process, built from validated env — never the deprecated
 * `stripe.api_key = ...` global pattern.
 */
export function buildStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

export interface CreateCheckoutSessionInput {
  orgId: string;
  contactEmail: string;
  /** Existing Stripe Customer, if this org has checked out before (e.g. a card declined). */
  stripeCustomerId: string | null;
  plan: PlanKey;
  successUrl: string;
  cancelUrl: string;
}

/**
 * A subscription Checkout Session for the given plan.
 *
 * `client_reference_id` carries the org id so the webhook can find its way
 * back to a HaulQ tenant with nothing but the Stripe objects the event
 * itself contains. No `payment_method_types` — see the security-review skill
 * note: omitting it lets Stripe pick eligible methods dynamically instead of
 * locking the checkout to cards only.
 */
export async function createCheckoutSession(
  billing: BillingClient,
  input: CreateCheckoutSessionInput,
): Promise<Stripe.Checkout.Session> {
  return billing.client.checkout.sessions.create({
    mode: 'subscription',
    client_reference_id: input.orgId,
    ...(input.stripeCustomerId
      ? { customer: input.stripeCustomerId }
      : { customer_email: input.contactEmail }),
    line_items: [{ price: billing.priceIds[input.plan], quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { orgId: input.orgId, plan: input.plan },
    subscription_data: { metadata: { orgId: input.orgId, plan: input.plan } },
  });
}

export class WebhookSignatureError extends Error {}

/** Verifies the `stripe-signature` header over the raw request body. */
export function constructWebhookEvent(
  stripe: Stripe,
  body: Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string,
): Stripe.Event {
  if (!signatureHeader) {
    throw new WebhookSignatureError('missing stripe-signature header');
  }
  try {
    return stripe.webhooks.constructEvent(body, signatureHeader, webhookSecret);
  } catch (err) {
    throw new WebhookSignatureError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Stripe's own subscription statuses, collapsed onto `orgs.status`.
 *
 * `incomplete`/`incomplete_expired` (first payment never succeeded) and
 * `unpaid` (final retry failed, no automatic cancellation configured) both
 * read as `past_due` here — HaulQ has no product distinction between "never
 * paid" and "stopped paying," only between paid and not.
 */
export function mapSubscriptionStatus(
  status: Stripe.Subscription.Status,
): 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'canceled':
      return 'cancelled';
    default:
      return 'past_due';
  }
}
