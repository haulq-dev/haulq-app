/**
 * Clerk and Stripe webhooks.
 *
 * Registered *without* `fastify-plugin` on purpose. That keeps the raw-body
 * content type parser below encapsulated to this route — the signature is over
 * the bytes as sent, and a re-serialized JSON object will not verify, but every
 * other route in the API wants parsed JSON.
 *
 * Only user events are handled from Clerk. Clerk's Organizations feature is not
 * used; see `packages/db/src/repositories/identity.ts` for why tenancy stays
 * in Postgres.
 *
 * Stripe events are the only thing that moves an org off `trialing` — see the
 * module note in `billing/stripe.ts`.
 */

import { activateSubscriptionForOrg, applySubscriptionUpdate, upsertUserFromIdentity } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import {
  SignatureError,
  verifySvixSignature,
} from '../auth/svix-signature.ts';
import { constructWebhookEvent, mapSubscriptionStatus, planFromMetadata, WebhookSignatureError } from '../billing/stripe.ts';
import { HttpError } from '../plugins/request-context.ts';

interface ClerkEmailAddress {
  id: string;
  email_address: string;
}

interface ClerkUserData {
  id: string;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
  first_name?: string | null;
  last_name?: string | null;
  phone_numbers?: Array<{ phone_number: string }>;
}

interface ClerkEvent {
  type: string;
  data: ClerkUserData;
}

/**
 * The primary address, not the first one.
 *
 * A user with a work and a personal address on the same Clerk account has both
 * in this array in no guaranteed order, and picking the wrong one means broker
 * correspondence goes to whichever they signed up with years ago.
 */
function primaryEmail(data: ClerkUserData): string | undefined {
  const addresses = data.email_addresses ?? [];
  if (data.primary_email_address_id) {
    const found = addresses.find((a) => a.id === data.primary_email_address_id);
    if (found) return found.email_address;
  }
  return addresses[0]?.email_address;
}

function fullName(data: ClerkUserData): string | undefined {
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
  return name || undefined;
}

export async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.post('/webhooks/clerk', async (request, reply) => {
    const secret = app.env.CLERK_WEBHOOK_SECRET;
    if (!secret) {
      // Refused rather than accepted-unverified. An endpoint that writes to the
      // users table with no signature check is an unauthenticated write
      // reachable by anyone who learns the URL.
      throw new HttpError(
        503,
        'webhooks_not_configured',
        'Webhooks are not configured on this deployment.',
      );
    }

    const body = request.body as Buffer;
    if (!Buffer.isBuffer(body)) {
      throw new HttpError(400, 'invalid_request', 'Expected a JSON body.');
    }

    try {
      verifySvixSignature({
        secret,
        headers: {
          id: request.headers['svix-id'] as string | undefined,
          timestamp: request.headers['svix-timestamp'] as string | undefined,
          signature: request.headers['svix-signature'] as string | undefined,
        },
        body,
      });
    } catch (err) {
      if (err instanceof SignatureError) {
        request.log.warn({ err: err.message }, 'rejected clerk webhook');
        throw new HttpError(401, 'invalid_signature', err.explanation);
      }
      throw err;
    }

    let event: ClerkEvent;
    try {
      event = JSON.parse(body.toString('utf8')) as ClerkEvent;
    } catch {
      throw new HttpError(400, 'invalid_request', 'That webhook body is not JSON.');
    }

    switch (event.type) {
      case 'user.created':
      case 'user.updated': {
        const email = primaryEmail(event.data);
        if (!email) {
          // Acknowledged, not retried. Clerk will keep redelivering a 4xx, and
          // a user genuinely without an email address will never gain one by
          // being sent again.
          request.log.warn({ clerkUserId: event.data.id }, 'clerk user has no email');
          return reply.code(200).send({ handled: false, reason: 'no email address' });
        }

        await upsertUserFromIdentity(app.db, {
          externalAuthId: event.data.id,
          email,
          fullName: fullName(event.data),
          phone: event.data.phone_numbers?.[0]?.phone_number,
        });

        return { handled: true };
      }

      case 'user.deleted': {
        /**
         * Deliberately not deleted here.
         *
         * `users` is referenced by `event_log.actor_user_id`, and an audit trail
         * whose actors have been removed is not an audit trail — guardrail 6.
         * Removing someone's *access* is a membership change, which is what
         * actually needs to happen and what the app already does.
         *
         * A real erasure request is a deliberate, logged operation that also
         * has to decide what happens to the events, and it does not belong on
         * an endpoint that fires whenever someone closes their account.
         */
        request.log.info(
          { clerkUserId: event.data.id },
          'clerk user deleted; local record retained for audit',
        );
        return { handled: true, note: 'record retained for audit' };
      }

      default:
        // 200, not 404. An unhandled event type is not an error, and returning
        // one makes Clerk retry it forever and eventually disable the endpoint.
        return { handled: false, reason: `unhandled type ${event.type}` };
    }
  });

  app.post('/webhooks/stripe', async (request, reply) => {
    const secret = app.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !app.billing) {
      // Same reasoning as the Clerk route above: refused, not accepted
      // unverified — this writes `orgs.status`, which is what decides
      // whether a carrier gets into the app at all.
      throw new HttpError(
        503,
        'webhooks_not_configured',
        'Webhooks are not configured on this deployment.',
      );
    }

    const body = request.body as Buffer;
    if (!Buffer.isBuffer(body)) {
      throw new HttpError(400, 'invalid_request', 'Expected a raw body.');
    }

    let event: Stripe.Event;
    try {
      event = constructWebhookEvent(
        app.billing.client,
        body,
        request.headers['stripe-signature'] as string | undefined,
        secret,
      );
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        request.log.warn({ err: err.message }, 'rejected stripe webhook');
        throw new HttpError(401, 'invalid_signature', 'Could not verify this webhook.');
      }
      throw err;
    }

    /**
     * `checkout.session.completed` fires the instant Checkout's payment
     * step clears — which for an async method (bank debit, for instance) is
     * before the payment has actually settled. `payment_status` is the
     * field that distinguishes the two; a session gated on `'paid'` here
     * waits for `checkout.session.async_payment_succeeded` instead. See the
     * Stripe best-practices skill's note on this exact trap.
     *
     * Looked up by `client_reference_id` (the org id `routes/billing.ts` set
     * when it created the session) rather than `session.customer` — the
     * Customer this session created is exactly what this write is attaching
     * to the org, so nothing yet has it to look an org up by.
     */
    const activateFromSession = async (session: Stripe.Checkout.Session, status: 'active' | 'past_due') => {
      if (!session.client_reference_id || typeof session.customer !== 'string') {
        return { handled: false };
      }
      const updated = await activateSubscriptionForOrg(app.db, session.client_reference_id, {
        status,
        plan: planFromMetadata(session.metadata),
        stripeCustomerId: session.customer,
        stripeSubscriptionId:
          typeof session.subscription === 'string' ? session.subscription : undefined,
      });
      if (!updated) {
        request.log.warn({ orgId: session.client_reference_id }, 'stripe checkout for unknown org');
      }
      return { handled: Boolean(updated) };
    };

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status !== 'paid') return { handled: false, reason: 'payment pending' };
        return activateFromSession(session, 'active');
      }

      case 'checkout.session.async_payment_succeeded':
        return activateFromSession(event.data.object, 'active');

      case 'checkout.session.async_payment_failed':
        return activateFromSession(event.data.object, 'past_due');

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        if (typeof subscription.customer !== 'string') return { handled: false };
        const updated = await applySubscriptionUpdate(app.db, subscription.customer, {
          status: mapSubscriptionStatus(subscription.status),
          plan: planFromMetadata(subscription.metadata),
          stripeSubscriptionId: subscription.id,
        });
        if (!updated) {
          request.log.warn({ stripeCustomerId: subscription.customer }, 'stripe subscription for unknown org');
        }
        return { handled: Boolean(updated) };
      }

      default:
        return reply.code(200).send({ handled: false, reason: `unhandled type ${event.type}` });
    }
  });
}
