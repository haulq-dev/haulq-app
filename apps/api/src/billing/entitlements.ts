/**
 * Product-level gating, on top of the plan/paywall gate `Shell.tsx` and
 * `routes/billing.ts` already handle — that gate answers "has this org paid
 * at all," this answers "is what they paid for enough for this route."
 *
 * Derived from `plan` at request time rather than read from `orgs.entitlements`
 * (the jsonb column built for a materialized product-access map, still
 * unwritten anywhere). With exactly two plans and a static mapping, deriving
 * from `plan` is simpler and cannot drift out of sync the way a denormalized
 * copy could — see that column's own comment in `schema/tenancy.ts`. Revisit
 * once a plan needs per-org customization a static map can't express.
 *
 * Dispatch's scoring/booking isn't a `GatedProduct` here — it doesn't run
 * inside this codebase yet (`ADR-0001`: `packages/core` is a separate,
 * unlinked repo until Phase 4). There is nothing here to gate until that
 * lands; add it then rather than guessing its shape now.
 */

import { getOrg, type Scope } from '@haulq/db';
import { HttpError } from '../plugins/request-context.ts';

export type GatedProduct = 'track' | 'routes';

const PRODUCT_LABEL: Record<GatedProduct, string> = {
  track: 'Track',
  routes: 'Routes',
};

/**
 * True for every plan on a Core-included product; both `GatedProduct`s
 * today are Fleet-only. A `null` plan (no subscription written yet) is
 * never entitled — reachable only if this runs on an org `Shell.tsx`'s own
 * gate would have already stopped at the paywall for.
 */
export function hasEntitlement(plan: 'carrier' | 'fleet' | null, _product: GatedProduct): boolean {
  return plan === 'fleet';
}

/**
 * Route guard, same shape as `requireRole` — call it after `requireScope`
 * (and after any `requireRole` check, so a role error surfaces before a
 * plan one). Looked up by `getOrg` rather than cached on the session: an
 * upgrade, downgrade, or payment failure takes effect on the very next
 * request, not the next sign-in.
 */
export async function requireEntitlement(s: Scope, product: GatedProduct): Promise<void> {
  const org = await getOrg(s);
  if (!org || !hasEntitlement(org.plan, product)) {
    throw new HttpError(
      403,
      'not_entitled',
      `${PRODUCT_LABEL[product]} needs the Fleet plan. Contact hello@haulq.ai to upgrade.`,
    );
  }
}
