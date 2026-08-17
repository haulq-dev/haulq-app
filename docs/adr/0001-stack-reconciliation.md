# ADR-0001 — Keep `packages/core` as it is; new stack for new surfaces

- **Status:** Accepted
- **Date:** 14 Aug 2026
- **Closes:** build plan section 12, row "Stack reconciliation" (blocked Phase 0 start)

## Context

The build plan's stack table (section 5) was written before anyone read
`ai-load-dispatcher`. Reading it produced a direct conflict:

| Layer | Stack table | `ai-load-dispatcher` |
|---|---|---|
| Repo tooling | Turborepo + pnpm | npm workspaces |
| ORM | Drizzle | hand-written SQL behind a `DispatchStore` interface |
| Database | Postgres 16 | `node:sqlite`, with the Postgres schema written and ready |
| Web | React + Vite + TanStack | Next.js |
| API | Fastify | Next.js route handlers |
| Core deps | Zod, etc. | **zero, deliberately** |

The zero-dependency core is not an accident. Node 22.6 strips types natively and
ships a test runner, so `packages/core` runs with no install and no build step.
It is 13,205 lines with 305 passing tests, including a scoring engine asserted
against distances DAT actually reported.

## Decision

Keep `packages/core` exactly as it is — dependency-free, board-agnostic, npm
workspaces, `node:sqlite` for local persistence — and treat it as HaulQ IQ's
scoring and adapter layer. Adopt the stack table only for surfaces that do not
exist yet.

Concretely:

- `ai-load-dispatcher/packages/core` is not modified, not moved and not
  converted. It gains no dependencies.
- New Phase 0 work lives in `haulq-app/`: pnpm workspaces, Turborepo, Drizzle,
  Postgres, Fastify, React + Vite + TanStack.
- The two are separate installs in one directory and separate CI jobs. `core`
  tests on bare Node with no `install` step at all, which is the property worth
  protecting.
- `apps/web` inside the dispatcher (Next.js, ~1,700 lines) is treated as a
  working prototype, not the product surface. It keeps running for the pilot
  carrier; it does not get extended.

## Consequences

**Accepted cost.** Two idioms in one directory, and a developer has to know
which they are in. The signal is the folder: anything under `haulq-app/` uses
the new stack, anything under `ai-load-dispatcher/` does not. CI enforces the
boundary by running `core` with no package manager.

**Rejected alternative — converge everything.** Rewriting the scoring engine
onto Drizzle, Zod and Fastify buys consistency and costs a tested engine plus
its 305 tests. Build plan section 4 already re-estimates Phase 4 down from 118h
to 45–60h *because* that code exists; converging spends the saving to make a
table in a document true.

**Rejected alternative — extend the existing stack instead.** Keeping npm
workspaces and hand-written SQL everywhere is the fastest start. It fails on
Phase 1: Docs, Pay and Insights are CRUD-heavy, which is exactly where the stack
table's high-leverage multiplier (3–4x, section 4) applies, and hand-writing SQL
for them throws that away.

## Integration path

Phase 4 is when the two meet, not before. Nothing in `haulq-app` imports from
`core` today, and no workspace link is wired, because a link with no consumer is
configuration that can only rot. When Dispatch starts:

1. `core` gains a `DispatchStore` implementation backed by Postgres, alongside
   the existing `node:sqlite` one. Its column names already match the Postgres
   schema, so this is mechanical — the interface in `store/types.ts` does not
   change.
2. `scored_loads` moves into the `haulq-app` schema with `carrier_id` renamed to
   `org_id` and a new nullable `load_id` pointing at `loads`. It stays a
   separate table from `loads`; see the note at the top of
   `packages/db/src/schema/loads.ts` for why.
3. `core` is consumed as a workspace package. It still has no dependencies.

## Revisit if

`core` acquires a dependency for a reason nobody can argue with. At that point
the zero-dependency property — the whole justification for this ADR — is gone,
and converging becomes the cheaper option.
