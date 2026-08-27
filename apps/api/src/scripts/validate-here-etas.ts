#!/usr/bin/env node
/**
 * `pnpm routes:validate-etas` — HERE's predicted arrival vs. what actually
 * happened, on real completed loads.
 *
 * PHASE_3_PLAN.md section 7a, the first of "two things to do before 3a is
 * scoped": "Validate HERE's ETAs against `truck_positions` before trusting
 * them... Compare HERE's predicted arrival against actual arrival on real
 * completed loads. This costs nothing, uses data that already exists, and
 * de-risks the one input every 3a verdict depends on." This is that
 * comparison, built once so it can be re-run any time more completed loads
 * exist, not a one-off analysis thrown away after a single read.
 *
 * A qualifying load needs, on every stop: coordinates (`load_stops.lat/lng`),
 * a real departure from the first stop (`departedAt`) and a real arrival at
 * the last (`arrivedAt`) — the two ground-truth timestamps Track (Phase 2)
 * exists to produce. `truck_positions` breadcrumbs are not read directly:
 * `arrivedAt` is Track's own detention-evidence timestamp, already the
 * authoritative "the truck was there, at this time" fact `previewTracking`
 * relies on elsewhere, so re-deriving arrival from raw GPS pings would be
 * trusting a noisier signal to answer a question a cleaner one already
 * answers. Section 2's "real ETA-vs-actual-arrival comparison is possible
 * today, for free" is what this script is; `truck_positions`' role was
 * making the *data* free, not being the read path itself.
 *
 * Sweeps every org, no tenant — same shape `findExceptionCandidates`
 * already uses for a script that runs outside any one request.
 */

import { randomUUID } from 'node:crypto';
import {
  closeDatabase,
  createDatabase,
  getTruck,
  listLoads,
  scope,
  schema,
  type LoadWithStops,
} from '@haulq/db';
import { loadEnv } from '../env.ts';
import { HereApiError } from '../integrations/here.ts';
import type { TruckProfile } from '../integrations/routing-provider.ts';
import { buildRoutingProvider } from '../runtime.ts';

const log = {
  info: (o: unknown, msg: string) => console.log(msg, o),
  warn: (o: unknown, msg: string) => console.warn(msg, o),
  error: (o: unknown, msg: string) => console.error(msg, o),
};

interface Comparison {
  orgName: string;
  reference: number;
  lane: string;
  hereMiles: number;
  predictedArrivalAt: Date;
  actualArrivalAt: Date;
  /** actual − predicted, minutes. Positive: arrived later than HERE said. Negative: earlier. */
  deltaMinutes: number;
  /** deltaMinutes against the load's own real elapsed time, not HERE's estimate — the spread that matters. */
  deltaPercentOfActual: number;
}

/** Every stop has coordinates, the first has departed, the last has arrived. */
function isQualifying(load: LoadWithStops): boolean {
  if (!load.truckId || load.stops.length < 2) return false;
  const sorted = [...load.stops].sort((a, b) => a.seq - b.seq);
  if (sorted.some((s) => s.lat === null || s.lng === null)) return false;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return first.departedAt !== null && last.arrivedAt !== null && last.arrivedAt > first.departedAt;
}

async function main() {
  const env = loadEnv();
  const provider = buildRoutingProvider(env, log);
  if (!provider) {
    console.error(
      'HERE_API_KEY is not set — nothing to validate against. See .env.example.',
    );
    process.exitCode = 1;
    return;
  }

  const db = createDatabase({ url: env.DATABASE_URL });

  try {
    const orgs = await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs);

    const comparisons: Comparison[] = [];
    const errors: Array<{ orgName: string; reference: number; error: string }> = [];
    let candidateCount = 0;

    for (const org of orgs) {
      const s = scope(db, {
        orgId: org.id,
        actor: { type: 'system', name: 'validate-here-etas' },
        correlationId: randomUUID(),
      });

      const delivered = await listLoads(s, { status: ['delivered', 'invoiced', 'paid'] });
      const qualifying = delivered.filter(isQualifying);
      candidateCount += delivered.length;

      for (const load of qualifying) {
        const truck = load.truckId ? await getTruck(s, load.truckId) : undefined;
        if (!truck) continue;

        const sorted = [...load.stops].sort((a, b) => a.seq - b.seq);
        const first = sorted[0]!;
        const last = sorted[sorted.length - 1]!;

        const truckProfile: TruckProfile = {
          maxWeightLbs: truck.maxWeightLbs,
          maxLengthFt: truck.maxLengthFt,
          boxHeightIn: truck.boxHeightIn,
          boxWidthIn: truck.boxWidthIn,
          hazmat: load.hazmat,
        };

        try {
          const route = await provider.route(
            sorted.map((stop) => ({ lat: stop.lat!, lng: stop.lng! })),
            truckProfile,
            { departAt: first.departedAt! },
          );

          const actualDurationMs = last.arrivedAt!.getTime() - first.departedAt!.getTime();
          const deltaMs = last.arrivedAt!.getTime() - route.arrivalAt.getTime();

          comparisons.push({
            orgName: org.name,
            reference: load.reference,
            lane: `${first.city}, ${first.state} → ${last.city}, ${last.state}`,
            hereMiles: route.miles,
            predictedArrivalAt: route.arrivalAt,
            actualArrivalAt: last.arrivedAt!,
            deltaMinutes: deltaMs / 60_000,
            deltaPercentOfActual: actualDurationMs > 0 ? (deltaMs / actualDurationMs) * 100 : NaN,
          });
        } catch (err) {
          const message = err instanceof HereApiError ? err.message : String(err);
          errors.push({ orgName: org.name, reference: load.reference, error: message });
        }
      }
    }

    if (comparisons.length === 0) {
      console.log(
        `No qualifying loads found (${candidateCount} delivered/invoiced/paid loads checked, ` +
          `across ${orgs.length} org${orgs.length === 1 ? '' : 's'}).\n\n` +
          "A qualifying load needs real Track data on every stop — coordinates, a driver-app or ELD " +
          "departure timestamp on the first stop, and an arrival timestamp on the last — not a CSV-imported " +
          "history row. This dataset does not have one yet. Re-run this once a real load has gone through " +
          "Track's driver check-in flow end to end.",
      );
      if (errors.length > 0) {
        console.log(`\n${errors.length} load(s) had qualifying data but HERE errored:`);
        for (const e of errors) console.log(`  Load ${e.reference} (${e.orgName}): ${e.error}`);
      }
      return;
    }

    console.log(`${comparisons.length} load(s) compared:\n`);
    for (const c of comparisons) {
      const sign = c.deltaMinutes >= 0 ? '+' : '';
      console.log(
        `  Load ${c.reference} (${c.orgName}) ${c.lane} — ${c.hereMiles.toFixed(1)} mi, ` +
          `predicted ${c.predictedArrivalAt.toISOString()}, actual ${c.actualArrivalAt.toISOString()}, ` +
          `${sign}${c.deltaMinutes.toFixed(1)} min (${sign}${c.deltaPercentOfActual.toFixed(1)}% of actual transit time)`,
      );
    }

    const deltas = comparisons.map((c) => c.deltaMinutes);
    const percents = comparisons.map((c) => c.deltaPercentOfActual).filter((p) => Number.isFinite(p));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanAbs = (xs: number[]) => mean(xs.map(Math.abs));
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    console.log('\nSummary:');
    console.log(`  mean signed error:   ${mean(deltas).toFixed(1)} min`);
    console.log(`  mean absolute error: ${meanAbs(deltas).toFixed(1)} min`);
    console.log(`  median signed error: ${median.toFixed(1)} min`);
    console.log(`  mean absolute error: ${meanAbs(percents).toFixed(1)}% of actual transit time`);
    console.log(
      '\nHAULQ_BUILD_PLAN.md section 1 / PHASE_3_PLAN.md section 7a note the industry-normal gap ' +
        'between two legitimate mileage standards is 3–5%. Treat this spread against that bar, not zero.',
    );

    if (errors.length > 0) {
      console.log(`\n${errors.length} load(s) had qualifying data but HERE errored:`);
      for (const e of errors) console.log(`  Load ${e.reference} (${e.orgName}): ${e.error}`);
    }
  } finally {
    await closeDatabase(db);
  }
}

await main();
