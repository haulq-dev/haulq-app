/**
 * Starting a subscription.
 *
 * One route: hand back a Checkout Session URL the same way
 * `routes/integrations.ts`'s Motive connect does — the browser navigates
 * there itself with its normal authenticated client, rather than this route
 * redirecting server-side and losing the session headers `requireScope`
 * needs.
 *
 * What happens *after* Checkout — marking the org `active`, recording the
 * plan — is `routes/webhooks.ts`'s `/webhooks/stripe` handler, not this
 * file. Checkout's success screen is not proof of payment; the webhook is.
 */

import { getOrg } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createCheckoutSession } from '../billing/stripe.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

export async function billingRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/v1/billing/checkout',
    {
      schema: {
        tags: ['Billing'],
        summary: 'Start a Carrier Core subscription',
      },
    },
    async (request) => {
      const s = await requireScope(request);
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

      const session = await createCheckoutSession(app.billing, {
        orgId: org.id,
        contactEmail: org.contactEmail,
        stripeCustomerId: org.stripeCustomerId,
        plan: 'carrier',
        successUrl: `${app.env.WEB_ORIGIN}/?checkout=success`,
        cancelUrl: `${app.env.WEB_ORIGIN}/?checkout=cancelled`,
      });

      if (!session.url) {
        throw new HttpError(502, 'checkout_failed', 'Stripe did not return a Checkout URL.');
      }

      return { url: session.url };
    },
  );
}
