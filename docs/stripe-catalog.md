# Stripe product catalog

Every Product and Price HaulQ Billing sells or has cataloged, in both Stripe modes.
Created 15 Sep 2026 against `HaulQ_CFO_Model.xlsx`'s Pricing sheet — see that file
for what each tier includes and why, and `HAULQ_BUILD_PLAN.md` section 12 for the
launch-gating decision.

**Only Core is wired into the app today.** `apps/api/src/env.ts`'s
`STRIPE_PRICE_CARRIER_MONTHLY` points at Core's price, and `routes/billing.ts`'s
Checkout only ever sells that one. Everything else below is cataloged ahead of
need — created so a Price id exists the day each tier's release gate is actually
met, not wired into Checkout or the paywall yet. Wiring a second tier in means
extending `PlanKey` in `apps/api/src/billing/stripe.ts` beyond its current
single member, not just flipping a price id.

Individual module prices (Docs, Pay, Insights, Verify Pro, Track, Routes,
Dispatch Assist) are **not** cataloged as Stripe objects — the CFO model's own
Pricing sheet says not to lead with seven separate SKUs at launch. They exist
only as reference numbers in that spreadsheet, for bundle-value allocation.

## Core — the only tier sold today

| | Test mode | Live mode |
|---|---|---|
| Product | `prod_VGWZQLFbzijOfY` | `prod_VGXXS6St74ra1V` |
| Price ($49/mo) | `price_1UG073EW0ODCVdCOESfmXgJu` | `price_1UG0SqIhbSoMF1VweJpewXmM` |

Docs, Pay, Insights, Verify Pro.

## Operations — not sold yet (Phase 2 release gate)

| | Test mode | Live mode |
|---|---|---|
| Product | `prod_VGXXLKJsr4mSlY` | `prod_VGXY7GCueeeOlK` |
| Price ($99/mo) | `price_1UG0RxEW0ODCVdCOXqf1syyW` | `price_1UG0SyIhbSoMF1Vwui3SKbst` |

Core plus Track and Routes.

## Complete — not sold yet (Phase 3 release gate)

| | Test mode | Live mode |
|---|---|---|
| Product | `prod_VGXXEYPxYl5RD2` | `prod_VGXYO56fmaAVmi` |
| Price ($149/mo) | `price_1UG0S6EW0ODCVdCONnlyAYPg` | `price_1UG0T6IhbSoMF1VwJpv0doZ2` |

Operations plus Dispatch Assist.

## Fleet Complete — not self-serve (PlansScreen's "Contact us" card)

Two Prices on one Product — a flat platform fee plus a per-truck seat, meant to
be two line items on one subscription rather than one Price with `quantity`
covering both.

| | Test mode | Live mode |
|---|---|---|
| Product | `prod_VGXXuh4MjR4JMQ` | `prod_VGXY3nW8Z3uvtu` |
| Platform price ($199/mo flat) | `price_1UG0SHEW0ODCVdCOTCKZnzlk` | `price_1UG0TlIhbSoMF1VwnmirBhFM` |
| Per-truck price ($49/mo, quantity = truck count) | `price_1UG0SHEW0ODCVdCOE2dvEDnj` | `price_1UG0TlIhbSoMF1VwNyRukr0s` |

## Autopilot — add-on, not sold yet (Phase 5 release gate)

Bounded automation with approval gates. Two variants on one Product, priced
differently for a single truck vs. a fleet seat.

| | Test mode | Live mode |
|---|---|---|
| Product | `prod_VGXXTbThJMt3yq` | `prod_VGXZSCIWFfOVP6` |
| Single-truck price ($79/mo flat) | `price_1UG0ShEW0ODCVdCO1dQ4zz9t` | `price_1UG0TvIhbSoMF1VwoHsGvynl` |
| Per-truck price ($49/mo, quantity = truck count) | `price_1UG0SiEW0ODCVdCOsQcTADzC` | `price_1UG0TwIhbSoMF1VwNzAvu0jb` |

## Doppler

Only `STRIPE_PRICE_CARRIER_MONTHLY` (Core's price) is an env var today — see
`.env.example`. The rest of this catalog has no corresponding env var until a
route actually sells it; add one at that point rather than pre-wiring price ids
for tiers Checkout can't reach yet.
