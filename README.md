# haulq-app

Phase 0 foundation for HaulQ. Core records, the event log, and the surfaces the
later products plug into.

This is one of two codebases in `C:\dev\haulq`. The other,
`ai-load-dispatcher`, is the working scoring engine and board adapters; it keeps
its own tooling and is not converted. See [ADR-0001](docs/adr/0001-stack-reconciliation.md).

## Layout

```
packages/db          Schema, migrations, the only package that talks to Postgres
packages/contracts   Zod schemas shared by api and web
apps/api             Fastify. api.haulq.ai
apps/web             React + Vite + TanStack. app.haulq.ai
```

## Running it

Needs Node 22.6+, pnpm 9, and a Postgres 16.

```bash
pnpm install
cp .env.example .env          # then fill in DATABASE_URL
pnpm db:migrate
pnpm dev
```

Real secrets come from Doppler (`doppler run -- pnpm dev`). Nothing real belongs
in `.env`.

## Deploying

`render.yaml` defines the whole thing — API web service, static site, Postgres.
Read [docs/deploy-render.md](docs/deploy-render.md) before applying it: the
repo does not exist on GitHub yet, and three settings need a paid plan.

Secrets come from Doppler via its Render integration. `DATABASE_URL` does *not*
— Render sets it from the database, and letting Doppler also define it means an
unrelated secret change can silently repoint the API at the wrong database.

## Migrations

Three phases, in this order, all run by `pnpm db:migrate`:

1. `packages/db/sql/pre/` — extensions, before any table exists
2. `packages/db/drizzle/` — generated from the Drizzle schema
3. `packages/db/sql/post/` — triggers, append-only grants, check constraints

Phases 1 and 3 are idempotent and re-run on every deploy. Phase 2 is generated
with `pnpm db:generate`, then **reviewed and committed**. Never run
`drizzle-kit push` against anything holding carrier data — it will drop a column
it does not recognize.

CI applies the migration twice, because a non-idempotent statement in `pre` or
`post` breaks the deploy *after* the one that introduced it.

## Onboarding

`POST /v1/orgs` is the only route that runs without a tenant, because it is the
one that creates it. It authenticates a *person* rather than a tenant, via
`authenticateUser`, and refuses agent actors outright — guardrail 5 applied at
the one place the usual check has no org to run in.

Org, carrier profile, owner membership and both events are one transaction. A
partial signup is worse than a failed one: an org with no owner cannot be
reached by the person who just created it, and no screen exists that would let
them fix it.

`GET /v1/onboarding` returns steps, not a progress bar. Each carries what it
`unlocks` and, while incomplete, what that is currently costing them. The step
most likely to be skipped is truck capabilities, and skipping it silently hides
loads — so it says so.

## Operating facts

The six numbers in `packages/contracts/src/operating-facts.ts` are the most
consequential thing a carrier enters. Every margin figure is arithmetic on top
of them, and Phase 0's exit gate is reconciling them against 30–90 days of the
carrier's own imported loads.

Validation lives in `contracts`, not the API, because the warnings have to
appear as the carrier types. Two severities, and the asymmetry is the design:

- **errors block** — arithmetically impossible or certainly a typo. The
  sharpest is the cross-field check: if the stated cost per mile is below what
  fuel alone costs at the given price and mpg, the number is wrong rather than
  unusual, and every margin prediction built on it would be optimistic in a way
  that looks plausible for months.
- **warnings do not** — unusual, with the reason given. An owner running a niche
  operation may be right and the warning wrong; refusing his number would make
  the product useless to him.

`PUT /v1/org/operating-facts` merges rather than replaces. Carriers fill these
in across two sittings — once at signup, once after the import gives them real
figures — and a replacing PUT would blank the first half.

## CSV import

Phase 0's exit gate. Staged, not streamed:

```
uploaded → mapping → validating → ready → committing → committed
```

Parsing and inserting in one pass fails on row 400 of 900 with half the data
written and no way to resume, and that is the outcome that makes a carrier give
up — which costs the tuning dataset the whole phase exists to produce.

Three things the pipeline insists on:

- **Nothing commits on a guess.** The upload response carries a proposed mapping
  *and five sample rows*, because a column called "Rate" might be linehaul or
  all-in, and a wrong guess produces an import that looks perfect and is wrong
  by the fuel surcharge on every load. Correcting a mapping costs a click, not a
  re-upload.
- **The original cells are kept after commit**, in `import_rows.raw`. When a
  carrier disputes an imported figure the answer is either "your file said
  $1,800" or "we parsed it wrong", and without the source values there is no way
  to tell which.
- **Imported miles and revenue are `actual_`, never `expected_`.** HaulQ never
  predicted them. Writing them as predictions would fake a closed loop and
  poison the data being collected to tune it.

`packages/contracts/src/csv.ts` is hand-written rather than a library call. The
failure that matters is not "the parser was wrong" but "the parser silently did
something reasonable with an unreasonable file" — so it reports the dialect it
detected, what it skipped, and why. See `csv.test.ts`: every case there is
something a real export does.

Coercion (`coerce.ts`) keeps *absent* and *unparseable* apart. An empty rate
cell is a load whose rate was never recorded; a cell reading "see email" is an
error. A silent zero for the second is invisible in ninety rows and drags
measured revenue per mile down until someone happens to look.

Brokers are matched on a normalized key, so "Acme Logistics", "ACME LOGISTICS,
INC." and "Acme Logistics LLC" become one broker rather than splitting broker
profitability three ways.

## Object storage

`ObjectStore` in `packages/db/src/storage.ts` — four methods, filesystem and
in-memory implementations today. Cloudflare R2 drops in behind it once the
bucket and Doppler secrets exist; R2 speaks S3, so that is the same code with a
different endpoint. Phase 1a needs the identical interface for rate
confirmations and PODs at far higher volume.

Keys are tenant-first (`<orgId>/imports/<id>.csv`) so a per-carrier lifecycle
rule is expressible and "delete everything for this carrier" is a prefix delete.

## The web app

`apps/web` — React 19, Vite, TanStack Router and Query, Tailwind 4.

The brand system is shared with `haulq-site`: navy, orange, Fraunces headings,
tabular mono numerals, square surfaces with one small radius. Those tokens are
copied rather than imported, because the two builds are deliberately independent
(build plan section 6 — a copy fix must not be able to break the app). If the
brand changes, both files change; that is the trade.

Five screens, aimed at one path: **sign up → carrier details → truck → costs →
import history → costs confirmed against real loads.** That is Phase 0's exit
gate, and it is walkable today.

Two things worth looking at:

- **Operating costs validate as you type.** `validateOperatingFacts` lives in
  `@haulq/contracts`, so the browser runs the same function the API does. A
  carrier sees "fuel alone is $0.50/mi" while typing rather than after
  submitting. Errors disable the save; warnings do not.
- **The import wizard mirrors the API's staging** — upload, map, review, commit
  — because the reason the pipeline is staged is that the carrier sees the
  damage before anything is written. The mapping step shows five real values
  beside each guessed column.

Until Clerk is configured, a striped bar across the top stands in for sign-in.
It is deliberately ugly: mistaking it for product chrome would be worse than
looking unfinished.

## Authentication

Two implementations of one interface, chosen by `AUTH_PROVIDER`:

- **`dev`** (default) reads the tenant and actor from request headers. Its
  constructor refuses to run when `NODE_ENV=production`, so a deployment that
  forgets to switch fails at startup rather than serving header-trusting auth to
  the internet.
- **`clerk`** verifies a Clerk session token and resolves the tenant from
  `org_memberships`. Written and tested; needs dashboard setup —
  see [docs/clerk-setup.md](docs/clerk-setup.md).

**Clerk answers one question: which person is this.** Tenancy stays in Postgres.
Clerk's Organizations feature is deliberately unused — two systems believing
they own who belongs to what, kept in step by a webhook, means the first
disagreement locks a carrier out of their own account or shows them someone
else's loads. Roles are read from Postgres on every request rather than from a
token claim, so revoking access takes effect immediately.

## Making a request in development

```bash
# sign up — no org header, because there is no org yet
curl -X POST localhost:3001/v1/orgs \
  -H 'x-haulq-user-id: <user uuid>' -H 'content-type: application/json' \
  -d '{"name":"Prairie Freight LLC","contactEmail":"owner@example.com","mcNumber":"MC-123456"}'

# everything after names the tenant
curl -X POST localhost:3001/v1/trucks \
  -H 'x-haulq-org-id: <org uuid>' -H 'x-haulq-user-id: <user uuid>' \
  -H 'content-type: application/json' \
  -d '{"label":"Unit 12","capabilities":{"liftgate":true}}'

curl localhost:3001/v1/onboarding -H 'x-haulq-org-id: <org uuid>' -H 'x-haulq-user-id: <user uuid>'
curl localhost:3001/v1/timeline   -H 'x-haulq-org-id: <org uuid>' -H 'x-haulq-user-id: <user uuid>'
```

Send `x-haulq-agent: <model-id>` instead of a user id to act as an agent, which
is how the guardrail-5 paths get exercised before Clerk lands. There is
deliberately no anonymous mode: code written against an implicit tenant is code
that has to be found and fixed later, which is the position `ai-load-dispatcher`
is in now.

## Adding a write

Follow `POST /v1/trucks`. The route validates and calls a repository; the
repository opens the transaction, inserts, and records the event. Routes contain
no SQL and no event calls.

That split is the point. The record and the event describing it are written by
the same function so they cannot be written apart — left to route handlers, the
third person to add a write forgets the event, nobody notices, and the audit
trail has a hole that cannot be backfilled because `event_log` is append-only.

New events go in `packages/db/src/events/catalog.ts`, with the sentence they
produce. A verb without one does not compile.

## Testing

```bash
pnpm test                                  # unit tests only
DATABASE_URL=postgres://... pnpm test      # everything
```

Integration suites skip without `DATABASE_URL` rather than failing, so a laptop
with no database still runs the unit tests. CI always sets it.

Tests run serially (`turbo run test --concurrency=1`). Tearing down a test org
means briefly disabling `event_log`'s append-only trigger, and that is global
rather than session-scoped — two suites doing it at once against one database
would produce append-only failures that look nothing like their cause.

## The parts that are hard to change later

Build plan section 13 names two things that cannot be retrofitted cheaply.
Both have their reasoning written into the source rather than left in a doc:

- **The load object** — `packages/db/src/schema/loads.ts`. Four decisions at the
  top of the file: one row per commercial load rather than per board posting;
  stops as rows; expected and actual both stored, always; provenance as a
  first-class field.
- **The event log** — `packages/db/src/schema/events.ts` and
  `sql/post/0200_event_log_append_only.sql`. Append-only is enforced by trigger
  and by revoked grants, and each org's events are hash-chained. Corrections are
  made by appending a compensating event; there is no other supported path.

## Guardrails that live in the database

Build plan section 9 lists seven. Four of them are schema-level here, because a
rule enforced in one service's code is a rule the other services will break:

| Guardrail | Where |
|---|---|
| 3 — never infer insurance | `brokers` holds asserted facts only. Verify's output gets its own table with source and timestamp, Phase 0b. |
| 4 — respect board terms | `loads.source_board`, `source_fetched_at`, `purge_after`. A board-sourced row cannot be inserted without provenance (`0500_constraints.sql`). |
| 5 — no binding AI commitments | `actor_type = 'agent'` is distinct from `'system'` in `event_log`, so a model's action is never indistinguishable from a cron job's. |
| 6 — audit everything | `event_log`, append-only and hash-chained. `explanation` is `not null`. |

## Conventions

Read `packages/db/src/schema/_shared.ts` before adding a table. Three rules:
`org_id` leads every tenant-scoped index, money is integer minor units plus an
explicit currency, and deletes are soft.

**No build step.** Node runs these files by stripping types, not compiling them,
which is what makes `packages/core` in the dispatcher repo run with no install
and keeps both codebases on one mental model. The price is that anything needing
*generated* code is unavailable: no parameter properties
(`constructor(readonly x: string)`), no enums, no decorators, no namespaces.
These typecheck perfectly and fail at runtime, so the failure arrives later than
you would like. Write explicit fields instead.

## Status

Phase 0 foundation, 244 tests, and a web app you can walk end to end.

**Phase 0's exit gate is reachable end to end**: a carrier can sign up, add a
truck, enter their costs, import 30–90 days of history from a messy CSV, and
reconcile those costs against it.

| | |
|---|---|
| `POST /v1/orgs` | sign up — no tenant required |
| `GET/PATCH /v1/org/profile` | carrier identity |
| `GET/PUT /v1/org/operating-facts` | the numbers scoring depends on |
| `GET /v1/onboarding` | what is done, and what each gap costs |
| `GET/POST /v1/trucks` | fleet, with capabilities |
| `GET/POST /v1/drivers`, `GET /v1/drivers/expiring` | drivers and lapsing credentials |
| `POST /v1/imports` → `PUT /:id/mapping` → `POST /:id/commit` | staged CSV import |
| `GET /v1/imports/history-summary` | what the imported history actually says |
| `POST /v1/imports/reconcile` | the exit gate |
| `GET /v1/timeline` | the audit trail |
| `GET /v1/members`, `POST /v1/members/invites` | members and invitations |
| `GET /v1/invitations/:token`, `POST .../accept` | preview and accept — no tenant needed |
| `GET /v1/orgs` | the accounts a person can act in |
| `POST /webhooks/clerk` | signature-verified user sync |

Not started: R2, loads beyond imported history, and screens for members and
drivers (both have working APIs).
See `../PHASE_0_RE_ESTIMATE.md` for what remains.

## Invitations

You invite an email, not a user — the person usually has no HaulQ account yet.
So `org_invitations` is a separate table from `org_memberships` rather than a
membership row with a null user: memberships are the access model, and every
authorization check joins through `user_id`.

The token is a credential and is treated as one. 32 random bytes, stored only as
a SHA-256 hash, expiring in seven days, revocable, and superseded when someone is
re-invited. It is returned exactly once — losing the link means re-inviting.

**The token is the authority, not the email.** Someone who signs in with a
different address than was invited still joins, and both addresses go in the
timeline. Carriers forward invitations constantly, and refusing would strand a
driver with no self-service fix — the token is already an unguessable, expiring,
revocable secret. Making it strict is a one-line change in
`packages/db/src/repositories/members.ts`, and the test documenting the current
behaviour would fail loudly.

Two rules are enforced in the repository rather than the UI, because a second
surface would eventually forget:

- **An org always keeps at least one owner.** Removing or demoting the last one
  leaves an account nobody can administer and no screen that can fix it.
- **Only an owner can create an owner.** A dispatcher who can mint owners has
  granted themselves a path to the carrier's finances.
