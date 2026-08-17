/**
 * Onboarding status.
 *
 * Build plan section 8 names VirtualDispatch's onboarding as "genuinely good"
 * and "the parity bar" — certifications, weight, rate per mile, hours, no-go
 * states, deadhead radius, preferred lanes. It also names their weakness:
 * everything is self-reported, hours typed by hand, no ELD tab.
 *
 * The design consequence is that matching their onboarding is not enough, and
 * a checklist of green ticks is the wrong shape anyway. What a carrier needs to
 * know is not "step 3 of 7" but **what each answer changes**. Setting truck
 * capabilities is not admin — it decides which loads they ever see, and getting
 * it wrong is silent.
 *
 * So every step carries an `unlocks` sentence, and steps that are incomplete
 * say what is currently happening instead. `required` distinguishes the two
 * steps without which nothing works from the ones that make it better.
 */

import { and, count, eq, isNull } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { drivers, trucks } from '../schema/fleet.ts';
import { carrierProfiles } from '../schema/tenancy.ts';

export interface OnboardingStep {
  id: string;
  title: string;
  done: boolean;
  /** True when nothing useful works without it. */
  required: boolean;
  /** What completing this changes. Present whether done or not. */
  unlocks: string;
  /** What is happening because it is not done. Absent once done. */
  consequence?: string;
}

export interface OnboardingStatus {
  steps: OnboardingStep[];
  completedRequired: number;
  totalRequired: number;
  /** True when every required step is done. */
  ready: boolean;
  /**
   * Phase 0's exit gate: operating facts checked against real imported loads.
   * Separate from `ready` because a carrier can use HaulQ before this, they
   * just cannot trust the margin figures yet.
   */
  factsReconciled: boolean;
}

export async function onboardingStatus(s: Scope): Promise<OnboardingStatus> {
  const [profile] = await s.db
    .select()
    .from(carrierProfiles)
    .where(eq(carrierProfiles.orgId, s.ctx.orgId));

  const [truckCount] = await s.db
    .select({ n: count() })
    .from(trucks)
    .where(and(eq(trucks.orgId, s.ctx.orgId), isNull(trucks.deletedAt)));

  const [driverCount] = await s.db
    .select({ n: count() })
    .from(drivers)
    .where(and(eq(drivers.orgId, s.ctx.orgId), isNull(drivers.deletedAt)));

  const facts = (profile?.operatingFacts ?? {}) as Record<string, unknown>;
  const hasCostPerMile = typeof facts['costPerMileCents'] === 'number';
  const hasFixedWeekly = typeof facts['fixedWeeklyCostCents'] === 'number';

  const trucksWithCapabilities = await s.db
    .select({ capabilities: trucks.capabilities })
    .from(trucks)
    .where(and(eq(trucks.orgId, s.ctx.orgId), isNull(trucks.deletedAt)));

  const anyCapabilitiesSet = trucksWithCapabilities.some(
    (t) => Object.keys((t.capabilities ?? {}) as object).length > 0,
  );

  const steps: OnboardingStep[] = [
    {
      id: 'identity',
      title: 'Carrier name and authority',
      done: Boolean(profile?.legalName && (profile?.mcNumber || profile?.usdotNumber)),
      required: true,
      unlocks:
        'Lets HaulQ check broker authority and insurance for you, and puts your MC number on messages brokers receive.',
      consequence:
        'Without an MC or USDOT number, broker verification cannot run and outgoing messages have no authority to cite.',
    },
    {
      id: 'truck',
      title: 'At least one truck',
      done: (truckCount?.n ?? 0) > 0,
      required: true,
      unlocks: 'Loads can be matched against what the truck can physically carry.',
      consequence: 'Nothing can be matched or assigned until a truck exists.',
    },
    {
      id: 'capabilities',
      title: 'What each truck can do',
      done: anyCapabilitiesSet,
      required: false,
      // The step most likely to be skipped and most expensive to skip, so the
      // consequence is spelled out rather than implied.
      unlocks:
        'Loads needing a liftgate, pallet jack or dock-high trailer are matched correctly instead of guessed.',
      consequence:
        'Loads that mention equipment you have may be hidden, and loads needing equipment you do not have may be shown.',
    },
    {
      id: 'driver',
      title: 'At least one driver',
      done: (driverCount?.n ?? 0) > 0,
      required: false,
      unlocks:
        'Loads can be assigned, and endorsements like TWIC or hazmat are matched against the freight.',
      consequence: 'Loads can be booked but not assigned to anyone.',
    },
    {
      id: 'operating_facts',
      title: 'What it costs you to run a mile',
      done: hasCostPerMile && hasFixedWeekly,
      required: true,
      unlocks: 'Margin figures use your actual costs rather than industry defaults.',
      consequence:
        'Every profit figure HaulQ shows is an estimate built on a default, which will not match your business.',
    },
    {
      id: 'reconcile',
      title: 'Check those costs against your own loads',
      done: Boolean(profile?.operatingFactsReconciledAt),
      required: false,
      unlocks:
        'Import 30 to 90 days of past loads and HaulQ can confirm your cost figures against what actually happened.',
      consequence:
        'Your cost figures have not been tested against real loads yet, so margin predictions are unverified.',
    },
  ];

  const required = steps.filter((s_) => s_.required);

  return {
    steps: steps.map(({ consequence, ...rest }) =>
      rest.done ? rest : { ...rest, consequence: consequence! },
    ),
    completedRequired: required.filter((s_) => s_.done).length,
    totalRequired: required.length,
    ready: required.every((s_) => s_.done),
    factsReconciled: Boolean(profile?.operatingFactsReconciledAt),
  };
}
