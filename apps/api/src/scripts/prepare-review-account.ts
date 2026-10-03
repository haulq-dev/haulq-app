#!/usr/bin/env node
/**
 * Get the App Store review login ready. See `maintenance/review-account.ts`
 * for what it does and why. Run from Render → haulq-api → Shell, which has the
 * production DATABASE_URL:
 *
 *   node --experimental-strip-types apps/api/src/scripts/prepare-review-account.ts \
 *     --email emmanuel234432@gmail.com --keep <carrier id prefix>
 *       prints the plan, changes nothing
 *
 *   ... the same, plus --apply
 *       does it
 *
 * `--user user_...` (the Clerk id from the Clerk dashboard) is required when
 * the email has more than one user row: it is the row a sign-in reaches.
 * `--role dispatcher` instead of the default owner, if the reviewer should not
 * see the money controls. `--activate` marks the kept carrier active when it
 * is still trialing (a manual comp; nothing gets past the paywall otherwise).
 * `--include-loads` also retires other carriers that have loads, and
 * `--include-comped` ones that are active with no Stripe subscription.
 * `--keep` can name a carrier the login isn't in yet; it is added.
 */

import { closeDatabase, createDatabase } from '@haulq/db';
import { loadEnv } from '../env.ts';
import { prepareReviewAccount } from '../maintenance/review-account.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROLES = ['owner', 'dispatcher', 'driver', 'accountant'] as const;

async function main() {
  const email = arg('email');
  const keep = arg('keep');
  const role = (arg('role') ?? 'owner') as (typeof ROLES)[number];
  if (!email || !keep || !ROLES.includes(role)) {
    console.log(
      'Usage: prepare-review-account.ts --email <login email> --keep "<carrier name or id prefix>" [--user user_...] [--role owner|dispatcher] [--activate] [--include-loads] [--include-comped] [--apply]',
    );
    process.exitCode = 1;
    return;
  }

  const db = createDatabase({ url: loadEnv().DATABASE_URL });
  try {
    const flag = (name: string) => process.argv.includes(`--${name}`);
    const { ok } = await prepareReviewAccount(db, {
      email,
      keep,
      role,
      activate: flag('activate'),
      includeLoads: flag('include-loads'),
      includeComped: flag('include-comped'),
      ...(arg('user') ? { user: arg('user')! } : {}),
      apply: flag('apply'),
      log: (l) => console.log(l),
    });
    if (!ok) process.exitCode = 1;
  } finally {
    await closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});