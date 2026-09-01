# HaulQ Routes, 3a — end-to-end walkthrough

Everything Phase 3a built, in the order a real carrier hits it, plus the
operator-side pieces that never show up in the UI — the `validate-here-etas`
benchmark script, and the honest state a deployment is in before `HERE_API_KEY`
exists at all. Roughly 20 minutes.

Assumes what `PHASE_3_PLAN.md` §7a resolved: **HERE, alone, for all of Phase
3.** HOS/duty-status data is deliberately not pulled — §7's resolution — so
every feasibility verdict in this walkthrough carries `hoursChecked: false`
on purpose, not as a bug to chase.

Create a fresh carrier for this walkthrough rather than reusing another
phase's — same reasoning `PHASE_1B_PAY_WALKTHROUGH.md`'s own note gives:
`load_stops.lat`/`lng`/`windowEnd` matter here in a way most other phases'
test loads never bothered to set.

---

## Before you start

Check the API's boot log for this line:

```
routing provider ready   {"routingProvider":"here"}
```

If instead you see:

```
HERE is not configured — feasibility checks are unavailable. Set HERE_API_KEY to enable them.   {"routingProvider":false}
```

`HERE_API_KEY` did not reach the service — every feasibility check in §§1–4
below will 503 with `code: "not_configured"` instead of doing anything. That
503 is itself correct behavior (§6 below is where you deliberately trigger
it), so do not mistake it for a bug if you have not set the key yet — just
know which one you are looking at.

**Confirm the key itself works, not just that it is present**, before
blaming the app for a HERE-side problem:

```bash
curl -s "https://router.hereapi.com/v8/routes?transportMode=truck&origin=39.0997,-94.5786&destination=38.6270,-90.1994&return=summary&apikey=<HERE_API_KEY>"
```

A JSON body with a `routes` array means the key is live. `401`/`403` means
the key is wrong, disabled, or the account's billing/card-on-file step
(`HAULQ_BUILD_PLAN.md` §11) never finished — fix that before anything below,
since the app's own error message here is just "HERE could not compute a
route," not a diagnosis of why.

---

## 1. A feasible load

- [ ] On **Trucks**, add one: label "Unit 1", **max weight 26,000 lbs**,
      **max length 26 ft**, **box height 136 in**, **box width 102 in** — a
      reasonable straight-box stand-in. All four reach `here.ts`'s
      `hereTruckParams` for every feasibility call; a truck missing any of
      them just sends no constraint for that dimension, silently.
- [ ] On **Loads**, **Add a load**: pickup Kansas City, MO
      (**39.0997**, **-94.5786**), delivery St. Louis, MO (**38.6270**,
      **-90.1994**), delivery appointment left blank, status **dispatched**,
      truck **Unit 1**. **Add load.**
- [ ] On the load's detail panel, find **Load N — feasibility**.
- [ ] Select **Unit 1** (or leave "Use the load's assigned truck").
- [ ] **Check feasibility.**

**Check:**

- [ ] A green **Feasible** pill.
- [ ] Miles and an arrival timestamp shown — a real HERE-computed route, not
      the haversine screening estimate Track's ETA uses elsewhere.
- [ ] **"Hours of service not checked yet"** is printed, always, on every
      result in this walkthrough — this is `hoursChecked: false`, and it
      should never silently disappear even on a feasible verdict.

---

## 2. Infeasible — a stop window the route cannot make

Reuse §1's load rather than creating a second one — **Load N — stops**, on
the same load's detail panel, edits a stop's window directly via
`PATCH /v1/loads/:id/stops/:stopId`.

- [ ] On §1's load, find **Load N — stops**. Set the delivery stop's
      **Window closes** to a few minutes from now — well inside what the
      real Kansas City → St. Louis drive time could reach. **Save this
      stop.**
- [ ] **Check feasibility** again, same load.

**Check:**

- [ ] A **Infeasible** pill.
- [ ] `decidingConstraint.code` is `stop_window_overrun`, and the message
      names the specific stop and its window close time — the exit gate's
      own requirement (`PHASE_3_PLAN.md` §1): a carrier told "no" needs the
      reason, not a bare refusal. Confirm it is the *new* time, not a stale
      one — the whole point of §2 is that the edit actually took.

**Set it back** (or well past a real arrival) before moving on, if you want
§1's load to read feasible again afterward.

---

## 3. Infeasible — a truck-legal restriction wins first

HERE's own truck-mode routing returns a notice when a route cannot avoid a
restriction the truck's dimensions trip — confirmed against HERE's own v8
docs: notices are included by default (no extra `return` flag needed), and
even when a restriction is genuinely unavoidable HERE still returns a route
carrying the notice rather than an error, which is what `feasibility()`'s
parsing assumes.

**Not yet triggered live, tried in earnest.** Storrow Drive in Boston
(a real, famously truck-restricted corridor) at both a legal and a wildly
oversized height, and Baltimore's hazmat-banned harbor tunnels with
`hazmat: true` — every attempt came back an identical route, no notices.
Truck routing measurably differs from car routing on the same trip (2.2x
the duration in the Boston case), so restriction-awareness is demonstrably
active; the specific coordinates just never forced an *unavoidable* one.
Confirm the *ordering* instead by reading `routing/feasibility.test.ts`'s
`'is infeasible on a HERE restriction, named, before the window is even
checked'` case, which pins this exact behavior with no network call, using
`violatedBlockedRoad` — a real documented HERE notice code, not a guess.

**Check, if you do find a real restricted lane to test:**

- [ ] `decidingConstraint.code` is HERE's own notice code (e.g.
      `violatedBlockedRoad`), not `stop_window_overrun` — the restriction
      wins even when the window would also have failed.

---

## 4. Two refusals that are not about routing at all

- [ ] **Missing coordinates.** Add a load through the quick-add form **with
      a truck assigned** but the coordinate fields left blank — a truck has
      to be on the load or the next check below fires first instead, per
      `routes/feasibility.ts`'s actual order: not-configured, then load
      exists, then a truck is resolved, *then* coordinates are checked.

**Check:** `422`, `code: "missing_coordinates"`, naming the specific stop
that lacks them — not a generic "bad request."

- [ ] **No truck.** Add a load with no truck assigned at all, leave the
      feasibility screen's truck picker on "Use the load's assigned truck",
      and check.

**Check:** `409`, `code: "no_truck"`.

Neither of these calls HERE at all — confirm by watching the API log; there
should be no outbound request for either case, since both fail before the
routing provider is ever reached.

---

## 5. The degrade path — HERE genuinely not configured

Skip this section on a deployment you intend to keep using afterward; it
requires a restart either side.

- [ ] Unset `HERE_API_KEY` (comment it out in `.env`) and restart the API.
- [ ] Confirm the boot log now reads `"routingProvider":false`.
- [ ] Check feasibility on any load.

**Check:**

- [ ] `503`, `code: "not_configured"`.
- [ ] The web screen shows a plain, calm line — **"Routing is not connected
      on this deployment yet"** — not `ErrorNote`'s red alert styling. This
      distinction matters: this is the deployment's actual current state on
      any environment without a HERE account, not an exceptional failure, and
      the UI should not read as broken to a carrier who has simply not gotten
      to that setup step yet.

Restore `HERE_API_KEY` and restart before continuing.

---

## 6. `validate-here-etas` — the operator-side check

Not a screen — a script, per `PHASE_3_PLAN.md` §7a's "validate before
trusting" item. Run it any time more completed loads exist:

```bash
pnpm routes:validate-etas
```

**Check, on a fresh dataset with no real Track history:**

```
No qualifying loads found (N delivered/invoiced/paid loads checked, across M orgs).

A qualifying load needs real Track data on every stop — coordinates, a driver-app
or ELD departure timestamp on the first stop, and an arrival timestamp on the
last — not a CSV-imported history row.
```

This is the **correct** output on a fresh dev database, not a broken script —
a CSV-imported load-history row has revenue and miles for Insights, never a
stop-level `departedAt`/`arrivedAt`, so nothing there qualifies.

**Exercised for real, 2026-09-01** — a real load (Kansas City, MO → St.
Louis, MO), a real truck, a real `POST /v1/loads/:id/feasibility` call
against the live HERE API (248.5 mi, feasible), then a real check-in link
and real `POST /v1/checkin/:token/stops/:stopId` calls reporting `departed`
and `arrived`, run against a local test database — never production. The
script found the one qualifying load and produced a real comparison:

```
Load 1 (Real Track Validation Co) Kansas City, MO → St. Louis, MO — 248.5 mi,
predicted 2026-09-01T17:35:24.966Z, actual 2026-09-01T17:35:31.991Z,
+0.1 min (+0.0% of actual transit time)
```

**Read the near-zero delta honestly, not as a headline accuracy number.**
The seed derived the "departed" timestamp *from* HERE's own predicted
transit time for this route, then set "arrived" to the moment the check-in
actually ran — so the near-perfect match is circular by construction, not
evidence that HERE is accurate to a tenth of a minute in general. What this
run actually proves: the full mechanism is real and wired correctly end to
end — real load, real HERE call, real Track check-in flow, real script
output — which is what `PHASE_3_PLAN.md` §5 required before 3b could start.
A genuinely independent accuracy read still needs an actual truck's actual
drive, whenever the first real pilot load goes through Track for real.

**Check, once a qualifying load exists:**

- [x] One line per load: HERE's predicted arrival, the real recorded arrival,
      signed delta in minutes and as a percentage of actual transit time.
- [x] A summary block: mean/median signed error, mean absolute error.
- [x] The closing note comparing that spread against the plan's own bar — a
      3–5% gap between two legitimate mileage standards is industry-normal,
      not a red flag; treat the number against that, not against zero. (Not
      a meaningful read yet on this one circularly-derived data point — see
      above.)

---

## 7. The actual exit gate

**Given one truck and one load, HaulQ returns feasible or infeasible, and if
infeasible, names the one constraint that decided it.** §§1–2 are that claim
end to end — a clean route and a stop-window overrun, each producing the
right pill and the right named reason. §3 is the same claim's other branch
(a truck-legal restriction), harder to force on demand but pinned by test.
§4 confirms the two checks that are not "HaulQ has an opinion" but "this
request cannot be answered yet," and are billed accordingly (a 4xx that
never reaches HERE). §6 is the standing check against the one input every
verdict here depends on — the routing provider's own numbers — kept
runnable rather than a one-time read.

---

## What is deliberately not covered

- **HOS/duty-status.** `PHASE_3_PLAN.md` §7, resolved 2026-08-27: deferred.
  Every verdict says so via `hoursChecked: false` rather than silently
  omitting the field. Not a gap this walkthrough works around — the intended
  shipped behavior.
- **Multi-load sequencing (3b).** A different, harder problem per §3 of the
  plan — closer to a constraint search than a lookup. §5's gate — validate
  3a against a real route before starting 3b — is now cleared: §6 above
  exercised the real mechanism end to end 2026-09-01. The one caveat is that
  run's delta is circular by construction (see §6), so a genuinely
  independent accuracy read is still worth getting from the first real
  pilot load, but that is no longer what is blocking 3b from starting.
- **Turn-by-turn / in-cab display.** §8 of the plan scopes this out of
  Phase 3 entirely — feasibility and navigation are different products even
  sharing one provider underneath.
- **The Trimble mileage benchmark.** §7a's second "before 3a is scoped" item.
  Needs its own free-trial signup, independent of everything above, and nothing
  in this walkthrough depends on it — it is a cross-check on HERE's numbers,
  not a gate on shipping.
- **No hazmat checkbox anywhere in the UI.** `loads.hazmat` reaches
  `here.ts`'s truck params correctly — every documented hazmat category is
  sent when it is true, verified live (§1 of this walkthrough does not
  cover it) — but nothing in `apps/web`'s quick-add form sets it. Flagging
  a real hazmat load still means a raw `POST /v1/loads` with
  `"hazmat": true` in the body.
- **A live-triggered truck-restriction notice.** §3 above — real attempts,
  no success yet. Not a gap in what shipped, but worth closing the loop on
  if a genuinely restricted lane ever turns up.
