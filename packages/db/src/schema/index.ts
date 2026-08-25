/**
 * The schema.
 *
 * Phase 0 (tenancy, fleet, the load object, documents, the event log, CSV
 * import) plus Phase 1a (documents, already listed above), Phase 1b
 * (`pay.ts`), Phase 2a (`track.ts`) and Phase 0b (`verify.ts`). No Dispatch
 * or Insights tables — Insights reads columns `loads.ts` and `pay.ts`
 * already carry rather than owning its own table, and Dispatch arrives in
 * Phase 4.
 *
 * The dispatcher's operational tables (`scored_loads`, `decisions`,
 * `broker_emails`, `poll_runs`) are NOT here. They stay in
 * `ai-load-dispatcher/packages/core/db/schema.sql` until Phase 4, per ADR-0001.
 * When they move, `carrier_id` becomes `org_id` and `scored_loads` gains a
 * nullable `load_id` pointing at this schema's `loads`.
 */

export * from './_shared.ts';
export * from './enums.ts';
export * from './tenancy.ts';
export * from './fleet.ts';
export * from './brokers.ts';
export * from './loads.ts';
export * from './documents.ts';
export * from './events.ts';
export * from './imports.ts';
export * from './pay.ts';
export * from './track.ts';
export * from './verify.ts';
