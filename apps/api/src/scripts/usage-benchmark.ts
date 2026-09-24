#!/usr/bin/env node
/**
 * `pnpm usage:benchmark` — per-org, per-month counts of the actions Stripe
 * Billing will meter, read straight from `event_log`.
 *
 * Built ahead of Andrew's (the pilot carrier) trial so his real month of usage
 * becomes the number the Carrier Core plan's included allowances are set
 * against, rather than a guess. Same sweep-every-org shape
 * `validate-here-etas.ts` already established for an operator script with no
 * one tenant to run inside.
 *
 * ---------------------------------------------------------------------------
 * What counts, and why
 * ---------------------------------------------------------------------------
 *
 * Each bucket below is one thing a single-truck carrier does, not one row in
 * the log — `document.received` is the document entering the pipeline once,
 * not every downstream `document.extracted`/`document.validated` echo of it.
 * Metering the echoes would charge a carrier twice for one upload.
 *
 * `broker.verified` counts only `actorType: 'user'` rows — an on-demand check
 * the carrier asked for. The nightly re-check sweep
 * (`broker.verification_changed`, actor `'system'`) runs on HaulQ's own
 * schedule, not the carrier's action, so it must not count against their cap
 * any more than an outbox retry would.
 *
 * **HaulQ Routes has no bucket here.** `feasibility.ts`'s module note is
 * explicit that 3a "needs no persistent state" — a feasibility check is never
 * written to `event_log` at all, so there is currently no way to answer "how
 * many feasibility checks did this org run" from this table. If Routes is
 * going to carry a usage cap, it needs its own event first (a
 * `load.feasibility_checked` verb, no `topic`, same shape as
 * `document.validated`) before this script — or Stripe metering — can see it.
 *
 * Insights has no bucket on purpose: `GET /v1/insights` is a read, and a read
 * is not something this codebase's own reasoning (`OUTBOX_POLL_MS`'s "nothing
 * polls itself" precedent, `document.extracted`'s "recorded, not reacted to"
 * note) treats as usage worth capping.
 */

import { countEventsByOrgMonth, createDatabase, closeDatabase, schema } from '@haulq/db';
import { loadEnv } from '../env.ts';

interface MonthBucket {
  orgName: string;
  monthStart: string; // 'YYYY-MM-01'
  documentsReceived: number;
  invoicesGenerated: number;
  brokerChecksByUser: number;
  trackCheckins: number;
}

async function main() {
  const env = loadEnv();
  const db = createDatabase({ url: env.DATABASE_URL });

  // Optional filter: `pnpm usage:benchmark -- --org=andrew` matches a
  // case-insensitive substring of the org name, so the pilot's numbers can be
  // pulled without wading through every test org this machine has created.
  const orgFilterArg = process.argv.find((a) => a.startsWith('--org='));
  const orgFilter = orgFilterArg?.slice('--org='.length).toLowerCase();

  try {
    const allOrgs = await db
      .select({ id: schema.orgs.id, name: schema.orgs.name })
      .from(schema.orgs);
    const orgs = orgFilter
      ? allOrgs.filter((o) => o.name.toLowerCase().includes(orgFilter))
      : allOrgs;

    if (orgs.length === 0) {
      console.error(orgFilter ? `No org name matches "${orgFilter}".` : 'No orgs found.');
      process.exitCode = 1;
      return;
    }

    const orgNameById = new Map(orgs.map((o) => [o.id, o.name]));
    const orgIds = new Set(orgs.map((o) => o.id));

    const [documents, invoices, checkins, verifications] = await Promise.all([
      countEventsByOrgMonth(db, 'document.received'),
      countEventsByOrgMonth(db, 'invoice.generated'),
      countEventsByOrgMonth(db, 'load_stop.checkin'),
      countEventsByOrgMonth(db, 'broker.verified', 'user'),
    ]);

    const buckets = new Map<string, MonthBucket>();
    const ensure = (orgId: string, month: string): MonthBucket => {
      const key = `${orgId}:${month}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          orgName: orgNameById.get(orgId) ?? orgId,
          monthStart: month,
          documentsReceived: 0,
          invoicesGenerated: 0,
          brokerChecksByUser: 0,
          trackCheckins: 0,
        };
        buckets.set(key, b);
      }
      return b;
    };

    const apply = (
      rows: Awaited<ReturnType<typeof countEventsByOrgMonth>>,
      pick: (b: MonthBucket) => { set: (n: number) => void },
    ) => {
      for (const row of rows) {
        if (!orgIds.has(row.orgId)) continue;
        pick(ensure(row.orgId, row.month)).set(row.count);
      }
    };

    apply(documents, (b) => ({ set: (n) => (b.documentsReceived = n) }));
    apply(invoices, (b) => ({ set: (n) => (b.invoicesGenerated = n) }));
    apply(checkins, (b) => ({ set: (n) => (b.trackCheckins = n) }));
    apply(verifications, (b) => ({ set: (n) => (b.brokerChecksByUser = n) }));

    const rows = [...buckets.values()].sort(
      (a, b) => a.orgName.localeCompare(b.orgName) || a.monthStart.localeCompare(b.monthStart),
    );

    if (rows.length === 0) {
      console.log(
        orgFilter
          ? `"${orgFilter}" matched an org, but it has no metered events yet.`
          : 'No metered events yet.',
      );
      return;
    }

    console.log(
      ['Org', 'Month', 'Docs', 'Invoices', 'Broker checks (user)', 'Track check-ins'].join('\t'),
    );
    for (const r of rows) {
      console.log(
        [
          r.orgName,
          r.monthStart,
          r.documentsReceived,
          r.invoicesGenerated,
          r.brokerChecksByUser,
          r.trackCheckins,
        ].join('\t'),
      );
    }
    console.log(
      '\nRoutes (feasibility checks) is not in this table — see the module note at the top ' +
        'of this script for why, and what to add before it can be.',
    );
  } finally {
    await closeDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
