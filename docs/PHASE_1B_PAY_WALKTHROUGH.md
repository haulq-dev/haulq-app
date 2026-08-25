# HaulQ Pay — end-to-end walkthrough

Everything Phase 1b built, in the order a real carrier hits it, plus a short
look at what it feeds Phase 1c (§8) — Insights has no walkthrough of its own
because it has nothing to *do*, only what Pay already wrote to read back.
Roughly 25 minutes. Unlike Docs, Pay needs no third-party account — no
Postmark, Azure or Anthropic key touches this phase — so this works
identically against the deployed app or a laptop with nothing but Postgres.

---

## Before you start

No boot-log line to check — Pay has no external dependency to be misconfigured.
The only precondition is a **truck** and a **load at `delivered`**, since that
is what makes a load invoiceable. `PHASE_1A_DOCS_WALKTHROUGH.md`'s Load 1 does
not qualify — it was created at `prospect` on purpose ("leave truck and status
alone") — so this walkthrough creates its own loads rather than reusing it.

---

## 1. Generate an invoice

- [ ] On **Trucks**, add one if you have not already.
- [ ] On **Loads**, add a load: Wichita, KS → Denver, CO, **rate $2,400**,
      **status `delivered`**, a truck assigned, broker "Prairie Freight."
- [ ] On **Pay**, click **Generate an invoice**. Pick that load. Two line
      items: `linehaul` / "Linehaul" / **$2,200**, and `fuel_surcharge` /
      "Fuel surcharge" / **$200**.
- [ ] **Generate invoice.**

**Check:**

- [ ] The invoice appears with status **draft**, total **$2,400.00** — the sum
      of the two line items, not the load's rate; the two are independent once
      an invoice is generated, on purpose.
- [ ] Its reference is a small sequential number (1, 2, 3…), the same pattern
      as a load's own reference.
- [ ] Click the invoice's reference number to open its detail panel below the
      table. Both line items are listed, no payments yet, no factoring packet.

---

## 2. Send it — the load moves to `invoiced`

- [ ] Click **Send** on the draft invoice.

**Check:**

- [ ] Status moves to **sent**.
- [ ] On **Loads**, the same load's status is now **invoiced** — Pay moved it
      there through the same status control Loads itself uses, not a separate
      mechanism, so this is the one place worth confirming the two screens
      agree.
- [ ] On **Activity**, both `invoice.generated` and `invoice.sent` are logged,
      each naming the load by its reference, not its id.

**Try generating a second invoice for the same load.** It should be refused —
`That load already has an invoice. Void it before generating another.` One
open invoice per load is enforced, not a suggestion.

---

## 3. A partial payment does not mark it paid

- [ ] Open the invoice's detail panel. Under **Payments**, **Record payment**.
- [ ] Amount **$1,000**, source **Broker, direct**, no reference needed.
      **Record payment.**

**Check:**

- [ ] The invoice's status is still **sent**. One payment now shows in the
      list, but the sum ($1,000) has not reached the total ($2,400).

- [ ] Record a second payment for the remaining **$1,400**, same source.

**Check:**

- [ ] The invoice flips to **paid** the moment the sum crosses the total, not
      on the first dollar.
- [ ] On **Loads**, the load's status is now **paid**, and its actual revenue
      reads **$2,400.00** — click the load to see the per-load margin panel;
      this is the number Insights' "estimated vs. reconciled" language was
      waiting on.
- [ ] On **Activity**, `invoice.paid` is logged, naming both the invoice and
      the load.

---

## 4. Void — and why it stops working after this point

- [ ] Add a second load and generate a second invoice against it, same
      numbers. **Do not send it.**
- [ ] Click **Void**, give a reason ("wrong accessorials"), confirm.

**Check:**

- [ ] Status is **void**, the reason shows in the detail panel.
- [ ] Generating a *new* invoice for that same load now works — voiding is
      what frees the load up again, not a dead end.

**Now try voiding the invoice from §3**, the one that reached `paid`.

**Check:**

- [ ] It is refused — a 409, message naming the invoice and explaining a paid
      invoice needs a reversal, not a void. This is the database's own status
      trigger talking, not a client-side guess at what should be allowed; if
      this one somehow succeeds, that is a real bug, not a maybe.

---

## 5. Factoring — assemble, submit, and get paid through a factor

- [ ] Add a third load, generate an invoice, **Send** it. Leave it unpaid.
- [ ] Scroll to **Factoring companies**, **+ Add**. Name "Apex Capital," any
      email.
- [ ] Open the unpaid invoice's detail panel. Under **Factoring**, choose
      Apex Capital, **Assemble packet**.

**Check:**

- [ ] The packet appears with status **assembling**.

- [ ] Click **Mark submitted**.

**Check:**

- [ ] Status moves to **submitted**.

- [ ] Click **Accepted**.

**Check:**

- [ ] Status moves to **accepted**.

- [ ] Back under **Payments**, **Record payment**: the full **$2,400**,
      source **Factor**, and pick this packet from the **Which packet**
      dropdown that appears once "Factor" is selected. **Record payment.**

**Check:**

- [ ] The invoice reaches **paid**, same as §3.
- [ ] The factoring packet's own status is now **funded** — set by the
      payment, not by a separate action. This is what makes "funded" an
      observed fact (money actually arrived, tagged to this submission)
      rather than a status someone clicked.
- [ ] On **Activity**, `factoring_packet.funded` is logged.

---

## 6. A factor's rejection, and resubmitting

- [ ] Add a fourth load, generate and send an invoice, assemble a packet
      against the same factor, mark it submitted.
- [ ] Click **Rejected**. It requires a reason — try leaving it blank first
      and confirm it refuses, then give one ("missing signed POD").

**Check:**

- [ ] Status is **rejected**, reason shown.
- [ ] Assemble a **second** packet for the *same invoice*, same or a
      different factor. This works — a rejected packet is a fact that
      happened, not a lock on trying again.

---

## 7. Receivables aging

- [ ] On **Pay**, look at the five tiles above the table.

**Check:**

- [ ] The invoice sent-but-unpaid from earlier sections shows under
      **Current**. It will not show a later bucket unless its due date has
      actually passed — and the quick-add load form has no field for a
      broker's payment terms, so every invoice in this walkthrough has no due
      date at all and reads as `—`. That is not a bug: no known terms is a
      different claim than "not yet overdue," and the aging view says so by
      counting it as current rather than hiding it.
- [ ] Paid and voided invoices never appear in any bucket — only `status:
      'sent'` counts as a receivable.

---

## 8. HaulQ Insights — what Pay feeds it

Not a Pay screen, and skippable if you are only verifying Pay itself — but
this is Phase 1c's own exit gate (`PHASE_1_PLAN.md` §4), and it has no
walkthrough of its own because it has nothing to *do*: no button here writes
anything, it only reads what §§3, 5 and 6 already wrote. Worth two minutes
now that there is real data behind it.

- [ ] Go to **Insights**. Find the **Payment performance** card.

**Check:**

- [ ] **Days to get paid** is a small number, close to 0 — every payment in
      this walkthrough was recorded the same session it was sent, so the
      average should reflect that rather than looking like a real carrier's
      pace.
- [ ] **Paid late** reads **0%**. Every invoice here has no due date on file
      (§7's own note on why), and a null due date cannot be "late" — this
      differs from receivables aging's `current` bucket, which is about
      *open* invoices, but the underlying reason is the same one.
- [ ] **Factoring rejected** reads **1** — the packet from §6, counted
      separately from a slow-but-eventually-paid invoice on purpose, so one
      number never blurs "always pays, just slowly" with "might not pay at
      all."
- [ ] Open one of the paid loads (from **Loads**, click the load itself) and
      confirm its margin panel shows the same actual revenue Pay wrote in
      §3 — this is `loadMargin`, a single-row read using the load's own
      columns, not a second calculation that could disagree with Pay's.

---

## 9. The actual exit gate

**A delivered load's documents produce an invoice with the right numbers on
it, a factoring packet a factor actually accepts, and the load's actual
revenue is written once money is known.** §§1–3 are the first and third
claims in the plain broker-direct case; §5 is the second, through a factor,
with the same reconciliation landing at the end either way. §8 is the
downstream half of the same claim — the numbers Insights shows are only
honest because Pay wrote them, not estimated it.

---

## What is deliberately not covered

- **`actualCost` / `actualMargin`.** Pay writes `actualRevenue` only — see the
  module comment at the top of `packages/db/src/schema/pay.ts`. Neither
  column gets written by anything in this phase; they need the carrier's real
  per-load operating cost, which no table here produces.
- **Actually emailing a factoring packet.** `factoring_packet.submitted` has
  an outbox `topic`, same shape as `document.received`'s, but nothing drains
  it yet — "submitted" today means a person reviewed the packet and sent it
  themselves. The event exists for an automated consumer to attach to later
  without a schema change, not because one runs now.
- **Multi-currency invoices.** `recordPayment` sums a currency-less total
  across all of an invoice's payments; every amount in this phase defaults to
  USD and nothing converts between currencies.
- **Role gating in detail**, beyond what falls out naturally above. Driver,
  dispatcher, accountant and owner see different write access on Pay's
  routes (`apps/api/src/routes/pay.ts`) — dispatcher and accountant can both
  generate/send invoices, only accountant and owner can void, record a
  payment, or touch a factoring company. Worth a glance if you invite a
  second person to test with, not required to confirm the pipeline itself
  works.
