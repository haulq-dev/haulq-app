# HaulQ Docs — end-to-end walkthrough

Everything Phase 1a built, in the order a real carrier hits it. Roughly 30
minutes, longer if the OCR section is included. Four fixture PDFs (beside this
file, in `fixtures/haulq-docs/`) carry you through it with no need to invent a
test document — they are real, readable PDFs built the same way the test suite
builds its own fixtures, not placeholder bytes.

Assumes what the title says: **Postmark's inbound credentials are configured
and verified** (§4 needs them; §§1–3 do not), R2, Azure and Anthropic keys are
in Doppler (§§5–6 need them; everything else does not), and you are testing
against the deployed app — most of what is worth catching here is
configuration, and none of it exists on a laptop. §§1–3 also work locally
against a Postgres with no external accounts, if that is what you are
verifying.

---

## Before you start

Check the API's boot log for this line:

```
document reader ready   {"readers":"local-pdf-text+azure-di/prebuilt-read/2024-11-30","ocr":true}
```

- `"readers":"local-pdf-text"` alone, no `+azure-di`, and `"ocr":false` means
  `AZURE_DI_ENDPOINT`/`AZURE_DI_KEY` did not reach the service — §5 will fail,
  and every scanned or photographed document will sit at `received` forever
  with nothing to read it.
- `"store":"filesystem"` on the object-storage line, in production, means the
  R2 vars did not reach the service either — uploads vanish on the next
  deploy.

**One more thing worth doing here rather than mid-walkthrough:** confirm the
Postmark inbound credentials actually match, since §4 depends on it and a
mismatch there reads as "the email never arrived" with nothing to explain why:

```bash
curl -i -u <POSTMARK_INBOUND_USER>:<POSTMARK_INBOUND_PASSWORD> \
  -X POST https://api.haulq.ai/v1/webhooks/postmark-inbound \
  -H 'content-type: application/json' -d '{}'
```

**401** means the credentials in Doppler and the ones in Postmark's inbound
stream webhook URL disagree — the whole username has to match, not just the
password. **400** means they agree and you are clear to move on; the body
being rejected is expected, since `{}` is not a Postmark payload.

---

## 1. Upload — everything agrees

- [ ] On **Loads**, add a load: Wichita, KS → Denver, CO, **rate $2,400**,
      **weight 42,000 lbs**, broker "Prairie Logistics". Leave truck and
      status alone.
- [ ] On **Documents**, upload `fixtures/haulq-docs/ratecon-agrees.pdf`.

**Check the inbox row appears within a few seconds** — extraction runs off
the outbox, not inline with the upload, so this is not instant. If it is
still `received` after 15–20 seconds, the outbox runner is not draining
(`OUTBOX_POLL_MS`) or the text-layer reader is not registered; check the boot
log above.

- [ ] Confirm it classified as **rate confirmation**, not `other`. The
      fixture's own printed title is what earns that — `classify.ts` scores a
      document's own words at 0.95, well over the 0.7 threshold, and never
      classifies on a filename alone.
- [ ] Open it. **Attach to…** the Wichita → Denver load.

**Check the disagreement view:**

- [ ] The banner reads **"Everything on this document agrees with the
      load"**, in green.
- [ ] `rate`, `weightLbs` and `equipment` all show as agreeing — no pill.
- [ ] `brokerLoadNumber` still shows a row: document says `RC-1001`, load says
      **`—`**, with an **info** pill. This is not a bug and it does not block
      anything — the quick-add load form has no field for a broker's own load
      number, so there is nothing on the load side to compare against. "The
      load has nothing recorded for this" is a true, non-blocking observation,
      which is exactly what an info-severity finding is for.

---

## 2. Upload — a packet that does not match

- [ ] Add a second load: Omaha, NE → Kansas City, MO, **rate $2,400**,
      **weight 42,000 lbs**, broker "Prairie Logistics" — same numbers as
      before, on purpose. The mismatch lives in the document, not the load.
- [ ] Upload `fixtures/haulq-docs/ratecon-disagrees.pdf` and attach it to the
      **Omaha → Kansas City** load. (The dropdown disambiguates by lane and
      reference — do not attach it to load 1 by mistake.)

**Check the disagreement view:**

- [ ] The banner is **red**: *"rate is $1,800.00 on the document but $2,400.00
      on the load."* One sentence, naming both figures — this is
      `describeDisagreements` in `@haulq/contracts`, and it is the same
      function the database used to decide the stored status, so the screen
      and the database cannot disagree about what "rejected" means.
- [ ] `rate` shows **error** — this is the only finding that can block a
      packet, and it is the one it should. This is deliberately the sharpest
      check in the pipeline: acting on it wrongly means shipping an invoice
      off another figure entirely.
- [ ] `weightLbs` shows **warning** (45,500 vs 42,000 — a scale reading 8% off
      is real and common, not a sign of a mismatched load) and `equipment`
      shows **warning** (Reefer vs Straight Box). Neither blocks. Warnings
      inform; only an error stops a packet.
- [ ] The document's status pill in the inbox list reads **rejected**, not
      quarantined and not stuck at `extracted`.

**Now correct it — the point of separating extraction from validation:**

- [ ] Re-attach the same document to **Load 1** (Wichita → Denver) instead —
      use the same **Attach to…** control; re-attaching is a normal action,
      not a special case.
- [ ] The verdict updates immediately, inline, without a re-upload. Attach is
      the one place validation runs synchronously rather than through the
      outbox — the person doing the attaching is looking at the screen and
      would otherwise see a stale verdict for several seconds.

---

## 3. Upload — dedupe

- [ ] Upload `ratecon-agrees.pdf` a second time, unmodified.

**Check:** the response is immediate and the inbox does not gain a second row.
A repeat send costs one hash and zero writes to the object store —
`documents_org_sha_key` is what makes a resend produce the same row rather
than a duplicate, and this is the property email intake depends on entirely,
since it is at-least-once by design.

---

## 4. Email intake

- [ ] On **Documents**, copy the address from the **"Or send it by email"**
      panel — `docs+{your-org-slug}@docs.haulq.ai`.
- [ ] From any real email account, send a message to that address with
      `fixtures/haulq-docs/ratecon-email.pdf` attached. Subject and body do
      not matter; only the attachment does.
- [ ] Wait roughly a minute — MX delivery, Postmark's parse, and the outbox
      poll all add latency an upload does not have — then refresh **Documents**.

**Check:**

- [ ] The document appears in the inbox, classified and extracted the same as
      an upload — same pipeline, same `document.received` event, different
      `source`.
- [ ] Open it. Its **From** field shows the address you sent from, not a
      Postmark address. **Source** reads `email intake`.
- [ ] Attach it to a third load (create one, or reuse **Load 1** if its rate
      still reads $2,400) and confirm the verdict renders exactly as §1 did —
      the intake path is different; the pipeline downstream of
      `document.received` is not.

**If your email signature has an inline logo image**, check that it did
**not** also appear as a separate document. The route only skips an
attachment carrying a `ContentID` when the message's `HtmlBody` actually
references it as `cid:{id}` — not on `ContentID` being present alone, since
Gmail stamps one on every attachment, inline or not, and treating presence
alone as the signal silently dropped real attachments sent from Gmail (found
and fixed 2026-08-22). If a signature logo shows up as a document, or — the
more serious direction — a real attachment silently does not, both are real
bugs, not a maybe.

**Resend the same email** (most clients have a literal "resend" — if not,
forward it to yourself and back, or just send the identical attachment
again). Confirm no second document appears, same as §3 — email intake is
at-least-once, and this is the property that makes that safe rather than
noisy.

---

## 5. OCR — the one thing not otherwise verified

Everything above runs on the free path: a digital PDF's own text layer, no
network call, no cost. This section is the only way to actually exercise
Azure, and it is worth doing even though it needs a document this repo cannot
ship as a fixture — the text-layer reader would just read it, and the point is
a document it cannot.

- [ ] Take an actual photograph of anything printed — a real BOL if you have
      one, otherwise any printed page — and upload it as a JPEG or PNG.

**Check:**

- [ ] It does not go straight to `extracted`. A photograph has no digital text
      layer, so the local reader declines it and it needs OCR — that decline
      is `ChainedDocumentReader`'s whole reason to exist, and it is what keeps
      the cost model honest: Azure is only ever billed for what step one
      actually could not read.
- [ ] Within the outbox's poll interval, it reaches `extracted` (or
      `received` still, honestly, if there was nothing legible on the page —
      HaulQ reports that rather than inventing a reading).
- [ ] Open the document. Its **Read by** field should name `azure-di` and
      `prebuilt-read`, not `deterministic-v1` alone — that is the field that
      proves this specific document actually reached Azure, not just that the
      service is configured for it.

---

## 6. The model pass

Needs `ANTHROPIC_API_KEY` set — check the boot log for `{"modelPass":true,"model":"anthropic/..."}`.
`{"modelPass":false,...}` means the key never reached the service, and everything below
will behave exactly like the model pass does not exist, which is the correct fallback but
not what this section is testing.

- [ ] Upload `fixtures/haulq-docs/packet-ambiguous.pdf` — three headings in one PDF (a rate
      confirmation, a BOL, a POD), which the deterministic rules can only score at 0.47
      confidence. Before this section existed, this is where a document stopped: `received`,
      forever, waiting for a person.

**Check:**

- [ ] It does **not** stay at `received`. Within the outbox's poll interval it reaches
      `extracted` — the model was asked, picked one kind, and the deterministic rules ran
      again against that kind to fill in anything they could now find honestly.
- [ ] Open the document. Its **Read by** field names an Anthropic model
      (`anthropic/claude-.../model-extract-v1`), not `deterministic-v1` alone.
- [ ] On the **Activity** screen, the read is attributed to that model as the actor — not to
      you, and not to the outbox. This is guardrail 5: a machine's reading is never recorded
      as a person's, and "which model, on which date" has to be answerable from the log
      alone.
- [ ] Whatever `rate` value it settled on, check it against the page: `$2,400.00` is the only
      number a correct reading can report, because it is the only number actually printed.
      A model that reported anything else would still have had to point at text that exists
      to survive `parseModelResponse`'s verification — if you see a wrong number here, that
      check has a hole in it, and that is a real bug to report, not a quirk of this fixture.

---

## 7. The actual exit gate

**A document goes in and comes out either agreeing with its load or
explaining exactly how it does not.** If §§1 and 2 both did that — one clean
agreement, one named disagreement with a sentence a carrier could act on — the
gate is met for both outcomes. §4 is the same claim again through the other
front door: a document that arrived by email has to reach the identical
verdict, or the two intake paths are not actually one pipeline.

---

## What is deliberately not covered

- **Factoring packets and invoices.** Phase 1b (Pay), not this phase.
- **`document.attached` and `document.rejected` on the Activity screen** —
  worth a glance after §§1–2, but the sentences are exercised directly above
  and re-checking them on the timeline is the same claim twice.
- **Tenant isolation for documents specifically.** Covered generally in
  `PHASE_0_WALKTHROUGH.md` §13; nothing about documents changes that story —
  `documents_org_sha_key` is scoped by `(org_id, sha256)`, so two carriers can
  hold the identical bytes and never see each other's copy.
