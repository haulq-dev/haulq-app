import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type Stripe from 'stripe';
import { createCheckoutSession, type BillingClient } from './stripe.ts';
import { dailyCapFor } from '../plan-limits.ts';

/** A BillingClient whose Stripe only records the Checkout Session it was asked for. */
function fakeBilling() {
  const created: Stripe.Checkout.SessionCreateParams[] = [];
  const billing = {
    client: {
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            created.push(params);
            return { id: 'cs_test', url: 'https://checkout.example' };
          },
        },
      },
    },
    priceIds: { carrier: 'price_core', fleetPlatform: 'price_platform', fleetPerTruck: 'price_truck' },
  } as unknown as BillingClient;
  return { billing, created };
}

async function fleetLineItems(truckCount: number) {
  const { billing, created } = fakeBilling();
  await createCheckoutSession(billing, {
    orgId: '00000000-0000-0000-0000-000000000001',
    contactEmail: 'ops@example.com',
    stripeCustomerId: null,
    plan: 'fleet',
    truckCount,
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
  });
  return created[0]?.line_items;
}

describe('Fleet checkout: the platform fee includes the first truck', () => {
  it('charges one truck as the platform fee alone', async () => {
    assert.deepEqual(await fleetLineItems(1), [{ price: 'price_platform', quantity: 1 }]);
  });

  it('charges the per-truck price for each truck after the first', async () => {
    assert.deepEqual(await fleetLineItems(5), [
      { price: 'price_platform', quantity: 1 },
      { price: 'price_truck', quantity: 4 },
    ]);
  });
});

describe('dailyCapFor', () => {
  it('multiplies the cap for Fleet only', () => {
    assert.equal(dailyCapFor('fleet', 20, 5), 100);
    assert.equal(dailyCapFor('carrier', 20, 5), 20);
    assert.equal(dailyCapFor(null, 20, 5), 20);
  });
});
