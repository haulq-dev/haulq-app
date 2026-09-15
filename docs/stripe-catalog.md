# Stripe product catalog

Every Product and Price HaulQ Billing sells or has cataloged, in both Stripe modes.
Created 15 Sep 2026 against `HaulQ_CFO_Model.xlsx`'s Pricing sheet — see that file
for what each tier includes and why, and `HAULQ_BUILD_PLAN.md` section 12 for the
launch-gating decision.

**Core and Fleet are wired into the app; Operations, Complete and Autopilot are
not.** `apps/api/src/env.ts`'s `STRIPE_PRICE_CARRIER_MONTHLY` and the two
`STRIPE_PRICE_FLEET_*` vars are what `routes/billing.ts`'s Checkout actually
sells, selected by `PlansScreen.tsx`'s two cards. Fleet's price scales with a
truck count the visitor types in on that screen — Checkout's `quantity` on the
per-truck line item, not a value HaulQ stores anywhere itself. The remaining
three tiers below are cataloged ahead of need — created so a Price id exists
the day each one's release gate is actually met, not reachable from Checkout
or the paywall yet.

Individual module prices (Docs, Pay, Insights, Verify Pro, Track, Routes,
Dispatch Assist) are **not** cataloged as Stripe objects — the CFO model's own
Pricing sheet says not to lead with seven separate SKUs at launch. They exist
only as reference numbers in that spreadsheet, for bundle-value allocation.

## Core — sold today

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

## Fleet Complete — sold today

Two Prices on one Product — a flat platform fee plus a per-truck seat, billed
as two line items on one subscription rather than one Price with `quantity`
covering both, since only one of the two scales with fleet size. `PlansScreen`
still sells this ahead of the fleet controls and multi-truck settlements the
CFO model's own release gate names — same tradeoff Core already makes against
Dispatch and Track.

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

## Billing Portal

One configuration per mode, created via the API (Dashboard config UI does
the same thing, no functional difference) — `POST /v1/billing/portal`
doesn't pass a `configuration` id, so Stripe uses whichever configuration
is `active` for the account in that mode. Payment method, invoice history,
and cancellation only — no `subscription_update`, on purpose. See
`createPortalSession`'s note in `apps/api/src/billing/stripe.ts`.

| | Test mode | Live mode |
|---|---|---|
| Configuration | `bpc_1UG1kAEW0ODCVdCOGHAYllXG` | `bpc_1UG1kMIhbSoMF1VwS7fAtHfM` |

## Doppler

`STRIPE_PRICE_CARRIER_MONTHLY`, `STRIPE_PRICE_FLEET_PLATFORM_MONTHLY` and
`STRIPE_PRICE_FLEET_PER_TRUCK_MONTHLY` are env vars today — see `.env.example`
and `render.yaml`'s Doppler `prd` list. Operations, Complete and Autopilot have
no corresponding env var until a route actually sells them; add one at that
point rather than pre-wiring price ids for tiers Checkout can't reach yet.
