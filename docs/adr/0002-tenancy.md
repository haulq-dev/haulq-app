# ADR-0002 — Extend the existing schema to multi-tenant

- **Status:** Accepted
- **Date:** 14 Aug 2026
- **Closes:** build plan section 12, row "Single-tenant to multi-tenant" (blocked Phase 0 scope)

## Context

`ai-load-dispatcher` was built for one carrier — a 26 ft straight box truck out
of Kansas — but its schema already carries `carrier_id` on every operational
table and scopes its unique constraints by it. The multi-tenant shape was
anticipated; it was just never populated with a second row.

## Decision

Extend. `carriers` becomes `orgs` plus `carrier_profiles`, and every
`carrier_id` maps to `org_id` one-to-one.

The split is the only structural change: `orgs` holds what any tenant has (name,
status, contact, entitlements), `carrier_profiles` holds what only a carrier has
(MC number, USDOT, operating facts). A broker tenant has no MC number, and a
column mandatory for 100% of real rows but nullable in the schema is a
validation rule pretending to be a schema.

Three deliberate additions:

- **`users` are global, not tenant-scoped.** A driver moving between two
  carriers on the platform is one person with two memberships; an owner running
  two authorities is one login. Tenant-scoped users force a second account for
  both, which carriers notice immediately and forgive slowly.
- **`org_memberships` carries the role.** A user can be `owner` at one org and
  `driver` at another.
- **`org_id` leads every index on a tenant-scoped table.** A query that forgets
  the tenant filter should be slow enough to notice.

## Isolation, and what is not done yet

Isolation is a convention today, not an enforcement. `forOrg(db, orgId)` in
`packages/db/src/client.ts` makes the tenant explicit at the boundary, but every
query still needs its own `where`.

Row-level security is Phase 0b, once Clerk is wired and there is a session to
derive a Postgres role from. `forOrg` is shaped so that switch happens inside
that one file — it starts issuing `set local app.org_id` in a transaction and no
call site moves.

This is a real gap and it is worth naming rather than implying otherwise. The
reason to defer: RLS policies written against an auth layer that does not exist
yet get written twice.

## Consequences

**Accepted cost.** The dispatcher's tables keep saying `carrier_id` until Phase
4 moves them. Two names for one concept, in two schemas, for several months. The
rename is a `alter table ... rename column` plus a backfill, and it is cheaper to
do it once at the move than to touch a running pilot twice.

**Rejected alternative — rebuild the org model around it.** A clean canonical
tenant schema with the dispatcher tables migrated into it is a better boundary
and costs Phase 0 hours the re-estimate (35–45h, section 4) does not have. The
extend path reaches the same schema; it just arrives at Phase 4 instead of now,
and gets there having shipped Docs and Pay in between.

## Revisit if

A tenant needs data residency, or a customer requires physical separation. Both
push toward database-per-tenant, which neither this decision nor its rejected
alternative accommodates.
