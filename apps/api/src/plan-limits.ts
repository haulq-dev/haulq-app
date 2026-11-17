import { getOrg, type Scope } from '@haulq/db';

/**
 * A per-carrier daily cap, adjusted for the carrier's plan. Fleet gets
 * `fleetMultiplier` times the base cap (`FLEET_DAILY_CAP_MULTIPLIER`); Core,
 * and an org with no plan yet, gets the base cap. The caps bound what one
 * carrier can cost HaulQ in paid calls, and Fleet pays enough to cover more.
 */
export function dailyCapFor(plan: string | null | undefined, base: number, fleetMultiplier: number): number {
  return plan === 'fleet' ? base * fleetMultiplier : base;
}

/** `dailyCapFor`, looking the plan up for the scope's org. */
export async function dailyCapForScope(s: Scope, base: number, fleetMultiplier: number): Promise<number> {
  const org = await getOrg(s);
  return dailyCapFor(org?.plan, base, fleetMultiplier);
}
