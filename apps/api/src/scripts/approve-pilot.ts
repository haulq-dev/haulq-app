#!/usr/bin/env node
/**
 * Approve a carrier for the HaulQ pilot, so its owner can subscribe
 * (`REQUIRE_PILOT_APPROVAL` in `env.ts`). Run from Render → haulq-api →
 * Shell, which has the production DATABASE_URL:
 *
 *   node --experimental-strip-types apps/api/src/scripts/approve-pilot.ts
 *       lists the carriers waiting on approval, oldest first
 *
 *   ... --org "<carrier name or id prefix>"
 *       shows which carrier that matches, changes nothing
 *
 *   ... --org "<carrier name or id prefix>" --apply
 *       approves it
 *
 * Approving does not email anyone. Tell the carrier yourself; the plans
 * screen picks it up the next time they open it.
 */

import { approvePilot, closeDatabase, createDatabase, findOrgs, listPendingPilots } from '@haulq/db';
import { loadEnv } from '../env.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const db = createDatabase({ url: loadEnv().DATABASE_URL });
  try {
    const target = arg('org');

    if (!target) {
      const pending = await listPendingPilots(db);
      if (pending.length === 0) {
        console.log('No carriers are waiting on pilot approval.');
        return;
      }
      console.log(`${pending.length} carrier(s) waiting on pilot approval:\n`);
      for (const p of pending) {
        console.log(`  ${p.orgId.slice(0, 8)}  ${p.orgName}  <${p.contactEmail}>  signed up ${p.createdAt.toISOString().slice(0, 10)}`);
      }
      console.log('\nApprove one with: --org <id prefix> --apply');
      return;
    }

    const matches = await findOrgs(db, target);
    if (matches.length !== 1) {
      console.log(
        matches.length === 0
          ? `No carrier matches "${target}".`
          : `"${target}" matches ${matches.length} carriers — use a longer id prefix:\n${matches.map((m) => `  ${m.orgId}  ${m.orgName}`).join('\n')}`,
      );
      process.exitCode = 1;
      return;
    }

    const [org] = matches;
    if (!process.argv.includes('--apply')) {
      console.log(`Would approve ${org!.orgName} (${org!.orgId}, ${org!.orgStatus}). Add --apply to do it.`);
      return;
    }

    await approvePilot(db, org!.orgId);
    console.log(`Approved ${org!.orgName} (${org!.orgId}). Its owner can subscribe now.`);
  } finally {
    await closeDatabase(db);
  }
}

await main();
