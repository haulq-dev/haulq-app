# Phase 0 — end-to-end walkthrough

Everything Phase 0 built, in the order a real carrier hits it. Roughly 30
minutes. Use `prairie-freight-history.csv` (beside this file) at step 5.

**Do this on the deployed app**, not locally. Most of what is worth catching now
is configuration — R2, Doppler, Clerk, Postmark — and none of it exists on a
laptop.

---

## Before you start

Check the API's boot log for these three lines. They are the cheapest
configuration check you will get, and two of them are new:

```
object storage ready   {"store":"r2","bucket":"haulq-documents"}
mailer ready           {"mailer":"postmark","from":"hello@haulq.ai"}
outbox runner started  {"intervalMs":5000,"topics":["member.invite_email"]}
```

- `"store":"filesystem"` in production means the R2 vars did not reach the
  service. Uploads will vanish on the next deploy.
- `"mailer":"log"` means invitations are being written to the log, not sent.
- No runner line, or `OUTBOX_POLL_MS is 0`, means nothing sends at all.

---

## 1. Sign up — the one route with no tenant

- [ ] Sign up as a brand-new person through Clerk.
- [ ] You land on the account picker with nothing to pick. **This is correct** —
      being signed in and belonging to nothing is a normal state, not an error.
- [ ] Create a carrier.

**Check:** the Clerk webhook fired and the user carries a real email, not a
placeholder. On the People screen you should see your address — not
"Address not synced yet".

> If it shows the placeholder, the session token has no `email` claim. Add it in
> Clerk → Sessions → customize session token. The stored address is no longer
> clobbered either way, but new users land on a placeholder until the webhook
> catches up.

---

## 2. Carrier profile

- [ ] Enter the legal name and an MC number written messily — `MC-123456`,
      `MC 123456`, `123456` should all normalise to digits.
- [ ] Save.

---

## 3. Trucks

- [ ] Add **Unit 12** and **Unit 7**. The fixture references both.
- [ ] Leave every capability off on one of them.

**Check:** the list warns "Nothing set — loads needing equipment may be hidden".
That warning is the point; a missing liftgate flag hides loads silently.

---

## 4. Operating facts — validation as you type

- [ ] Enter a **cost per mile below what fuel alone costs** at the fuel price and
      mpg you gave. Try `$0.30`.

**Check:** an *error* appears, not a warning, and Save is disabled. This is the
sharpest cross-field check in the product — the number is wrong rather than
unusual, and every margin figure built on it would look plausible for months.

- [ ] Enter something unusual but defensible instead. It should *warn* and let
      you save. Errors block, warnings inform.

---

## 5. Import — the exit gate

Upload `prairie-freight-history.csv`. It is a deliberately messy export: 42
loads across 88 days, a report title and date range above the headers, a stray
blank row, a totals row at the bottom, CRLF endings, a byte-order mark, three
date formats interleaved, a quoted comma, an embedded newline, and four rows
with specific problems.

**On the mapping screen:**

- [ ] All 15 headers map with no manual work.
- [ ] **Check `Load #`.** It maps to `brokerLoadNumber` at 0.9 confidence. For a
      carrier's own export that is probably wrong — it is more likely their own
      `reference`. Correcting it is the mapping screen doing its job; if it feels
      wrong every time, the pattern order in `import-mapping.ts` is worth a look.
- [ ] Five sample rows appear beside the guesses. Confirm they are real values,
      not headers.

**On the validation screen — four rows should be flagged:**

| Row | Cell | What must happen |
|---|---|---|
| 8 | rate `see email` | **Error.** Unparseable is not zero. A silent zero here is invisible in ninety rows and drags measured revenue per mile down until someone notices |
| 20 | rate empty | **Not an error.** Absent means the rate was never recorded — different from unparseable, and the coercer keeps them apart |
| 27 | delivery state empty | Flagged |
| 32 | deadhead `-5` | Flagged — miles cannot be negative |

- [ ] Commit the import, skipping the bad rows.

**Check afterwards:**

- [ ] The totals row did **not** become a load. 42 rows in, 42 loads considered.
- [ ] `import_rows.raw` still holds the original cells. When a carrier disputes a
      figure the answer is either "your file said $1,800" or "we parsed it
      wrong", and without the source values there is no way to tell which.

---

## 6. Broker matching

The file contains seven broker spellings for **four** real companies.

- [ ] Confirm the brokers list shows **four**, not five or seven.

All three Acme spellings — `Acme Logistics, Inc.`, `ACME LOGISTICS LLC`,
`Acme Logistics` — collapse into one. So do `Heartland Transport Services` and
`Heartland Transport Svcs.`

> **Fixed 2026-08-20.** The Heartland pair used to produce two brokers.
> `ENTITY_SUFFIXES` already stripped `services?`, so the long spelling reduced
> to `heartland` — but `Svcs.` was a word nothing recognised and reduced to
> `heartland svcs`, splitting one broker's profitability in half.
> `brokerMatchKey` now expands abbreviations to their full form *before*
> stripping suffixes, so the two passes answer separate questions: are these
> the same word, and does that word carry meaning.

**If you imported before 2026-08-20**, any duplicate broker rows already
created are still there — matching is applied at lookup, not retroactively. New
loads will attach to whichever row exists, but the existing pair needs merging
by hand. On a database that has only ever held test data, re-importing is
simpler.
## 7. Reconcile — the actual exit gate

- [ ] Run the reconcile step against the imported history.
- [ ] Confirm the operating facts now read as measured rather than estimated.
- [ ] The Activity screen shows *"Reconciled operating costs against N loads over
      the last 88 days. Scoring now uses measured figures rather than
      estimates."*

**That sentence is Phase 0's exit gate.** If you see it, the gate is met.

---

## 8. Loads

- [ ] The imported loads appear, newest first, with references starting at 1.
- [ ] Add a load by hand: Wichita KS → Denver CO, `$1,500`, 522 loaded miles,
      **176 deadhead**.

**Check the per-mile figures.** It should read about **$2.15/total mi** with
`$2.87 loaded` in grey beside it. The large number is the total-mile rate. If
the flattering loaded-mile figure is the headline, that is the bug the whole
product exists to avoid.

- [ ] Add a load with no deadhead recorded. It should say "no deadhead recorded"
      rather than assuming zero — assuming zero produces the flattering number
      by default.

**Then walk the state machine:**

- [ ] Try to move a booked load back to prospect → refused, *"load N cannot move
      backwards"*.
- [ ] Try to dispatch with no truck → refused.
- [ ] Assign Unit 12, then dispatch → works.
- [ ] Jump dispatched straight to delivered → **allowed**. Skips are legal; a
      short local run really does go delivered → paid the same afternoon.
- [ ] Cancel a load with no reason → refused.
- [ ] Cancel with a reason → works, and the reason shows on the row.
- [ ] Try to reopen the cancelled load → refused.

---

## 9. Drivers

- [ ] Add a driver with a **CDL expiring in under 30 days**.
- [ ] Add another with a medical card **already expired**.

**Check:** the strip at the top of the screen turns **red** (not amber) once
anything has actually lapsed, and says "Out of service". An expired medical card
is a truck that cannot legally move, not a filing task.

- [ ] Confirm the date you entered comes back as the same date. The API wants a
      full UTC timestamp and a date input gives `YYYY-MM-DD`; the conversion
      uses midday UTC so a US timezone cannot roll it back a day.

---

## 10. People and the invite loop — the newest path

- [ ] Invite an address you can actually read, as a `dispatcher`.
- [ ] The token panel appears. **It appears once** — only a hash is stored.
- [ ] **An email arrives.** Check the link points at `app.haulq.ai`, not
      `localhost`. A localhost link means `WEB_ORIGIN` is unset on the API and
      Doppler is not carrying it.
- [ ] Open the link in a **private window**, signed out.
- [ ] You see the carrier name, the role, and what it grants **before** any
      sign-in prompt.
- [ ] Sign in from that screen and accept. You land inside the carrier.
- [ ] The Activity screen names both addresses if they differ. The token is the
      authority, not the email — carriers forward invitations constantly.

**Then the failure paths:**

- [ ] Open an already-accepted link → a sentence explaining it, not a crash.
- [ ] Withdraw a pending invitation, then open its link → refused.

---

## 11. Roles

- [ ] As an owner, demote yourself when you are the only owner → refused,
      *"The only owner. Promote someone else first."*
- [ ] Sign in as the dispatcher. Confirm they can add loads and drivers but
      cannot change roles or remove members.

---

## 12. Mobile

Open the app on a phone, or DevTools at 375px.

- [ ] No horizontal scroll on **any** screen.
- [ ] The hamburger appears on mobile and **not** on desktop.
- [ ] Activity: a long explanation wraps inside its card.
- [ ] Loads, Trucks and Import: wide tables scroll **inside their own box**, not
      by widening the page.

---

## 13. Tenant isolation

- [ ] Create a second carrier from the same account.
- [ ] Switch to it. You see zero loads, zero trucks, zero drivers.
- [ ] The first load you create there is **reference 1** again — references are
      per-carrier, so nobody can infer another carrier's volume.

---

## What is deliberately not covered

- **Documents** — Phase 1a, not built.
- **Verify / mc-lookup** — the FMCSA key is set, so `haulq.ai/tools/mc-lookup`
  should answer now. Test that separately on the marketing site; it is not part
  of the app.
- **The outbox's other topics** — `document.received`, `load.booked`,
  `import.committed` and two more are queued with no consumer. That is by
  design; they accumulate until something handles them.
