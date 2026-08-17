/**
 * The Phase 0 schema.
 *
 * Scope is deliberately the foundation only: tenancy, fleet, the load object,
 * documents, the event log, CSV import. No Dispatch, Docs, Pay or Insights
 * tables — those arrive with their phases.
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
