# HaulQ Docs — extraction hardening, next scope

Written 2026-08-25, after testing `classify.ts`/`extract.ts` against 7 real
rate confirmations from 6 different brokers (sent by Andrew, the pilot
carrier) and fixing what they found. That work is commit `542f281`. This
file is the scope for whoever picks it up next — what's fixed, what's
deliberately not, and what's still open from the same session.

---

## 1. What's already fixed (commit `542f281`)

- `classify.ts` recognizes "CARRIER DISPATCH" as a rate confirmation title
  (one real broker never says "rate confirmation" anywhere on the page).
- `extract.ts` rejects a captured reference number with no digit in it
  (`requireDigit` on `brokerLoadNumber`/`invoiceNumber`/`bolNumber`) — this
  is the important one: it fixes two cases where the old rule *confidently
  returned the wrong value* ("At" or "must," picked up from unrelated
  nearby text) rather than finding the real number further down the page
  or honestly reporting it missing.
- Bare `"Total:"` as a last-resort `rateAmount` label, a `"PO#"` label for
  `brokerLoadNumber`, `"Trailer Req"` and `"Line Haul Rate"` as synonyms,
  and a shared fix so a parenthetical unit (`"Weight (lbs):"`) no longer
  breaks a label match.
- 10 new regression tests, all against synthetic fixtures reproducing the
  real structure (not the real documents — those are a carrier's own
  business correspondence and don't belong in source control).

Read the commit message and the diff before touching this file's rules
again — the comments on `requireDigit`, the `labelled()` helper, and the
bare-`"total"` fallback each explain a real tradeoff, not just what the
regex does.

---

## 2. Deliberately not fixed — pick one of these next

Each of these is real, found against an actual document, and was left
alone because the right fix needs design, not a regex swap. Attempting one
carelessly risks turning "field missing" (safe, triggers a model call)
into "field confidently wrong" (the exact failure class item 1 above just
closed).

### a. Value-before-label ordering

Nolan Transportation Group's rate confirmation prints `$2500.00 Line Haul`
— the number first, the label after. Every `FieldRule` in `extract.ts`
assumes label-then-value, including how the matched label text gets
recorded for the "read by" field shown in the disagreement view
(`match[0].slice(0, match[0].length - captured.length)` in
`extractDeterministically` — this assumes the label is the *prefix*, which
is false for a reversed match).

A real fix needs a `reversed?: boolean` on `FieldRule`, a second matching
branch that captures group 1 before the label instead of after, and the
label-text bookkeeping corrected for that case. Write it as a genuinely
separate code path rather than trying to make one regex handle both
directions — that's how the label-provenance field quietly starts lying
about what it matched.

### b. Table headers separated from their values by a line break

Real, common pattern — Cowboy's Logistics' weight (`Weight:` header, value
on the next line), TQL's trailer type (`Trailer Type` header, `Straight
Box Truck` value one line down). Matching in this file is strictly
per-line on purpose (see the module comment on `labelled()` — an
unanchored, line-crossing match is how `INVOICE` reads the first word of
the *next* line as an invoice number).

A correct fix needs real table awareness: recognizing a header row and
associating it with the next non-header row, which is a different kind of
parser than a per-line regex sweep. Do not attempt a "look at the next
line if this one has no value" patch without real test coverage — that's
exactly the shape of change that silently grabs the wrong column the first
time a table has more than one row.

### c. A PDF whose text layer is garbage despite looking like a normal digital PDF

Flock Freight's rate confirmation renders as a completely normal document
visually, but a naive text-layer extraction produces gibberish
(`6WRS 6WRS7\SH...`) — almost certainly a font-subsetting issue (no
`ToUnicode` CMap) in however that PDF was generated.

This was never confirmed against HaulQ's own reader — `LocalDocumentReader`
was never actually run against this specific file, only reasoned about.
**First step, not a fix**: run the real Flock Freight PDF (ask Andrew to
resend it, or find another from the same broker) through
`apps/api/src/documents/reader.ts` directly and see what `read.text`
actually contains. If it's garbage there too, the real problem is that
`pipeline.ts`'s `needs: 'ocr'` only fires when `!read.text` — a text layer
that exists but is useless currently looks identical to a good one, all
the way to a wasted (or confidently wrong) model call. The fix, if
confirmed, is likely a text-quality heuristic before classification runs,
not a document-reader change.

---

## 3. Untested document kinds — same methodology, more documents

This round only covered `rate_confirmation`. `classify.ts`/`extract.ts`
also have real rules for `invoice`, `bol`, `scale_ticket`/`weight_ticket`,
and `lumper_receipt`, and classify-only rules for `pod`, `w9`,
`insurance_certificate`, `carrier_packet` — none of those have been
checked against a single real document yet, only synthetic fixtures.

Ask Andrew for a few of each (his actual W-9 and current COI are
low-friction — he sends those to every new broker anyway) and repeat this
session's exact method: manually trace each one through the real rules
by hand before touching the live pipeline, the same way this round found
7 real gaps from 7 documents before writing a line of code.

---

## 4. Two production issues raised mid-session — last known status: open

Neither was resolved before this session ended. Re-check current status
before assuming either is still true.

- **Postmark inbound webhook returning 403.** Confirmed the API has no
  code path that produces a 403 on `/v1/webhooks/postmark-inbound` — every
  response it can send is 200, 400, 401 or 503. That means something in
  front of Render is blocking the request before it reaches the app.
  Suspected Cloudflare, if `api.haulq.ai`'s DNS record is proxied (orange
  cloud) rather than DNS-only. Needs: confirm the proxy setting, then check
  Cloudflare's Security → Events log for the blocked request if it is
  proxied.
- **`document.received` outbox job failing with `"The specified key does
  not exist."`** — an R2/S3 `NoSuchKey` error, meaning a `documents` row
  points at an object that genuinely is not in the bucket. Retries with
  backoff up to 8 attempts (`DEFAULT_MAX_ATTEMPTS` in
  `packages/db/src/events/outbox.ts`) and will never succeed, since the
  object isn't coming back on its own. Needs the actual `documentId` to
  investigate further — the log line only carries the outbox `seq`, not
  which document — which needs direct Postgres access this session never
  had.

---

## 5. Nothing in section 1 has been verified against the live pipeline

Every fix above was verified by manual trace against the real documents'
text, plus unit tests against synthetic fixtures reproducing that
structure — `packages/contracts` needs no database and no deployed app, so
that's genuinely solid. But none of it has been run through
`processDocument` against Postgres and R2 for real. Docker was broken on
this machine for the entire session (`Inference manager` failing to start,
unrelated to anything here), so this is a real gap, not an oversight.

---

## Recommended order

1. **Verify section 1 against the live app first.** Fast, and it closes
   the loop on work that's already committed — upload a document shaped
   like one of the 7 (or the real one, if privacy allows) and confirm the
   fix behaves the same live as it did on paper.
2. **Chase the two open production issues (§4)** before doing more
   hardening — they're live carrier-facing problems, not test gaps.
3. **Get more document types from Andrew (§3)** and repeat the method —
   this is what actually found everything fixed so far, more valuable
   than guessing at more edge cases from a desk.
4. **Pick one of §2's three deferred fixes**, once there's a specific
   document motivating it rather than doing it in the abstract.
