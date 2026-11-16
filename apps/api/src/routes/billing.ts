/**
 * Starting a subscription, and managing one afterward.
 *
 * Both routes hand back a Stripe-hosted URL the same way
 * `routes/integrations.ts`'s Motive connect does — the browser navigates
 * there itself with its normal authenticated client, rather than this route
 * redirecting server-side and losing the session headers `requireScope`
 * needs.
 *
 * What happens *after* Checkout — marking the org `active`, recording the
 * plan — is `routes/webhooks.ts`'s `/webhooks/stripe` handler, not this
 * file. Checkout's success screen is not proof of payment; the webhook is.
 *
 * The Portal route is narrower than Checkout on purpose — payment method,
 * invoice history, cancellation. Plan switching stays on `PlansScreen.tsx`'s
 * own Checkout buttons; see `createPortalSession`'s note in
 * `billing/stripe.ts` for why.
 */

import { getOrg, pilotApprovedAt, type Org } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createCheckoutSession,
  createPortalSession,
  FleetNotConfiguredError,
  NoStripeCustomerError,
} from '../billing/stripe.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

const CheckoutBodySchema = z.object({
  plan: z.enum(['carrier', 'fleet']).default('carrier'),
  /** Required, and only meaningful, for `plan: 'fleet'` — the per-truck line item's quantity. */
  truckCount: z.coerce.number().int().min(1).optional(),
});

/**
 * Whether this carrier may start Checkout. Approval only gates a carrier's
 * first subscription: one that has subscribed before (a Stripe customer) or
 * is active is let through, so a past-due owner can always fix their card.
 */
export function canSubscribe(org: Pick<Org, 'entitlements' | 'stripeCustomerId' | 'status'>, requireApproval: boolean): boolean {
  if (!requireApproval) return true;
  return pilotApprovedAt(org.entitlements) !== null || org.stripeCustomerId !== null || org.status === 'active';
}

export async function billingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/billing/eligibility',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Whether this carrier may subscribe yet (pilot approval)',
      },
    },
    async (request) => {
      const s = await requireScope(request, { allowInactiveSubscription: true });
      const org = await getOrg(s);
      if (!org) throw new HttpError(404, 'not_found', 'No account found for this session.');
      return { canSubscribe: canSubscribe(org, app.env.REQUIRE_PILOT_APPROVAL) };
    },
  );

  server.post(
    '/v1/billing/checkout',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Start a Core or Fleet subscription',
        body: CheckoutBodySchema,
      },
    },
    async (request) => {
      const s = await requireScope(request, { allowInactiveSubscription: true });
      requireRole(request, 'owner');

      if (!app.billing) {
        throw new HttpError(
          503,
          'not_configured',
          'Billing is not configured on this deployment yet.',
        );
      }

      const { plan, truckCount } = request.body;
      if (plan === 'fleet' && truckCount === undefined) {
        throw new HttpError(400, 'invalid_request', 'Fleet needs a truck count of at least 1.');
      }

      const org = await getOrg(s);
      if (!org) throw new HttpError(404, 'not_found', 'No account found for this session.');
      if (!canSubscribe(org, app.env.REQUIRE_PILOT_APPROVAL)) {
        throw new HttpError(
          403,
          'pilot_not_approved',
          "Your carrier hasn't been approved for the HaulQ pilot yet. We'll email you as soon as it is.",
        );
      }

      let session;
      try {
        session = await createCheckoutSession(app.billing, {
          orgId: org.id,
          contactEmail: org.contactEmail,
          stripeCustomerId: org.stripeCustomerId,
          plan,
          truckCount,
          successUrl: `${app.env.WEB_ORIGIN}/?checkout=success`,
          cancelUrl: `${app.env.WEB_ORIGIN}/?checkout=cancelled`,
        });
      } catch (err) {
        if (err instanceof FleetNotConfiguredError) {
          throw new HttpError(503, 'not_configured', 'Fleet billing is not configured on this deployment yet.');
        }
        throw err;
      }

      if (!session.url) {
        throw new HttpError(502, 'checkout_failed', 'Stripe did not return a Checkout URL.');
      }

      return { url: session.url };
    },
  );

  server.post(
    '/v1/billing/portal',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Open a Stripe Billing Portal session — payment method, invoices, cancellation',
      },
    },
    async (request) => {
      const s = await requireScope(request, { allowInactiveSubscription: true });
      requireRole(request, 'owner');

      if (!app.billing) {
        throw new HttpError(
          503,
          'not_configured',
          'Billing is not configured on this deployment yet.',
        );
      }

      const org = await getOrg(s);
      if (!org) throw new HttpError(404, 'not_found', 'No account found for this session.');

      try {
        const session = await createPortalSession(app.billing, {
          stripeCustomerId: org.stripeCustomerId,
          returnUrl: `${app.env.WEB_ORIGIN}/profile`,
        });
        return { url: session.url };
      } catch (err) {
        if (err instanceof NoStripeCustomerError) {
          throw new HttpError(
            409,
            'not_subscribed',
            'Subscribe to a plan first — there is nothing to manage yet.',
          );
        }
        throw err;
      }
    },
  );
}
