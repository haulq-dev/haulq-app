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

export type PlanKey = 'carrier' | 'fleet';

/**
 * What `runtime.ts`'s `buildBilling` decorates the app with.
 *
 * Fleet's two prices are optional independently of `carrier` — Core has to
 * be configured for `billing` to exist at all (see `buildBilling`'s gate),
 * but a deployment can run with only Core self-serve and Fleet still
 * unpriced. `routes/billing.ts` 503s a Fleet checkout specifically when
 * either is missing, rather than making the whole billing surface wait on
 * both.
 */
export interface BillingClient {
  client: Stripe;
  priceIds: {
    carrier: string;
    fleetPlatform?: string | undefined;
    fleetPerTruck?: string | undefined;
  };
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
  /** Required for `plan: 'fleet'` only — the per-truck line item's quantity. Ignored for `carrier`. */
  truckCount?: number | undefined;
  successUrl: string;
  cancelUrl: string;
}

/** Thrown by `createCheckoutSession` when `plan: 'fleet'` is requested but Fleet's prices aren't configured. */
export class FleetNotConfiguredError extends Error {}

function lineItemsFor(
  billing: BillingClient,
  input: CreateCheckoutSessionInput,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  if (input.plan === 'carrier') {
    return [{ price: billing.priceIds.carrier, quantity: 1 }];
  }

  if (!billing.priceIds.fleetPlatform || !billing.priceIds.fleetPerTruck) {
    throw new FleetNotConfiguredError('STRIPE_PRICE_FLEET_PLATFORM_MONTHLY / _PER_TRUCK_MONTHLY not set');
  }
  // `routes/billing.ts` already validates this before calling in — checked
  // again here so the type this function returns is honest, not because
  // this call site is expected to be the one that catches a bad request.
  if (input.truckCount === undefined) {
    throw new Error('truckCount is required for plan: fleet');
  }
  // Two line items on one subscription, not one Price with `quantity`
  // covering both — the platform fee is flat regardless of fleet size, the
  // per-truck fee is not. See docs/stripe-catalog.md.
  return [
    { price: billing.priceIds.fleetPlatform, quantity: 1 },
    { price: billing.priceIds.fleetPerTruck, quantity: input.truckCount },
  ];
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
    line_items: lineItemsFor(billing, input),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { orgId: input.orgId, plan: input.plan },
    subscription_data: { metadata: { orgId: input.orgId, plan: input.plan } },
  });
}

/** The plan a Checkout Session or Subscription's metadata says it's for — both are set by `createCheckoutSession` above. Falls back to `carrier` for a row from before Fleet existed, or metadata that's missing entirely. */
export function planFromMetadata(metadata: Stripe.Metadata | null | undefined): PlanKey {
  return metadata?.['plan'] === 'fleet' ? 'fleet' : 'carrier';
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
