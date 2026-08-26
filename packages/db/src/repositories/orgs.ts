/**
 * Orgs, carrier profiles and operating facts.
 *
 * `createOrg` is the one function in the codebase that runs without a tenant,
 * because it is the function that makes one. Everything else in here takes the
 * usual `Scope`.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../client.ts';
import { scope, type Actor, type Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { carrierProfiles, orgMemberships, orgs, users } from '../schema/tenancy.ts';
import { withTransaction } from '../transaction.ts';
import type { Optional } from '../types.ts';

export type Org = typeof orgs.$inferSelect;
export type CarrierProfile = typeof carrierProfiles.$inferSelect;

/** What `createOrg` needs in place of a `Scope`, since there is no org yet. */
export interface BootstrapContext {
  actor: Extract<Actor, { type: 'user' }>;
  correlationId?: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface CreateOrgInput {
  name: string;
  contactEmail: string;
  contactPhone?: string | undefined;
  mcNumber?: string | undefined;
  usdotNumber?: string | undefined;
}

export class OnboardingError extends Error {
  readonly explanation: string;

  constructor(message: string, explanation: string) {
    super(message);
    this.name = 'OnboardingError';
    this.explanation = explanation;
  }
}

/**
 * URL-safe handle from the carrier's name.
 *
 * A random suffix is appended unconditionally rather than only on collision.
 * Checking first and appending on conflict is a race — two carriers named
 * "Midwest Freight" signing up in the same second both see the slug free — and
 * the retry loop that fixes it is more code than the suffix.
 */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'carrier'}-${randomUUID().slice(0, 6)}`;
}

/**
 * Create a tenant, its carrier profile, and its first membership.
 *
 * All four writes — org, profile, membership, events — are one transaction. A
 * partial signup is worse than a failed one: an org with no owner is
 * unreachable by the person who just created it, and there is no screen anywhere
 * that would let them fix it.
 */
export async function createOrg(
  db: Database,
  bootstrap: BootstrapContext,
  input: CreateOrgInput,
): Promise<{ org: Org; profile: CarrierProfile }> {
  // Checked before the transaction so the failure is a clear message rather
  // than a foreign key violation mentioning a constraint name.
  const [user] = await db.select().from(users).where(eq(users.id, bootstrap.actor.id));
  if (!user) {
    throw new OnboardingError(
      `user ${bootstrap.actor.id} not found`,
      'Your sign-in is not linked to a HaulQ user yet. Sign out and back in, and if it persists, contact support.',
    );
  }

  const s = scope(db, {
    // Replaced below once the org exists. Nothing reads it before then.
    orgId: '',
    actor: bootstrap.actor,
    correlationId: bootstrap.correlationId ?? randomUUID(),
    ...(bootstrap.ipAddress ? { ipAddress: bootstrap.ipAddress } : {}),
    ...(bootstrap.userAgent ? { userAgent: bootstrap.userAgent } : {}),
  });

  return withTransaction(s, async (tx) => {
    const [org] = await tx.db
      .insert(orgs)
      .values({
        name: input.name,
        slug: slugify(input.name),
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone ?? null,
        type: 'carrier',
        status: 'trialing',
      })
      .returning();
    if (!org) throw new Error('org insert returned nothing');

    const [profile] = await tx.db
      .insert(carrierProfiles)
      .values({
        orgId: org.id,
        legalName: input.name,
        mcNumber: input.mcNumber ?? null,
        usdotNumber: input.usdotNumber ?? null,
      })
      .returning();
    if (!profile) throw new Error('carrier profile insert returned nothing');

    await tx.db.insert(orgMemberships).values({
      orgId: org.id,
      userId: bootstrap.actor.id,
      role: 'owner',
      status: 'active',
      acceptedAt: new Date(),
    });

    // From here the events belong to the org that now exists.
    const inOrg: Scope = { ctx: { ...tx.ctx, orgId: org.id }, db: tx.db };

    await recordEvent(inOrg, 'org.created', {
      subjectId: org.id,
      payload: { name: org.name },
    });

    await recordEvent(inOrg, 'member.joined', {
      subjectId: org.id,
      payload: { email: user.email, role: 'owner' },
    });

    return { org, profile };
  });
}

/**
 * Look up a tenant by its slug, with no `Scope` — there is no tenant yet to
 * scope to. Postmark inbound email intake is the caller: a shared inbound
 * address routes to an org via plus-addressing (`docs+{slug}@...`), and the
 * slug is the only stable, already-unique handle an org has for that.
 */
export async function getOrgBySlug(db: Database, slug: string): Promise<Org | undefined> {
  const [row] = await db.select().from(orgs).where(eq(orgs.slug, slug));
  return row;
}

/** The tenant's own row. `slug` is the field this exists for right now — see below. */
export async function getOrg(s: Scope): Promise<Org | undefined> {
  const [row] = await s.db.select().from(orgs).where(eq(orgs.id, s.ctx.orgId));
  return row;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getCarrierProfile(s: Scope): Promise<CarrierProfile | undefined> {
  const [row] = await s.db
    .select()
    .from(carrierProfiles)
    .where(eq(carrierProfiles.orgId, s.ctx.orgId));
  return row;
}

export type UpdateCarrierProfileInput = Optional<{
  legalName: string;
  dbaName: string | null;
  mcNumber: string | null;
  usdotNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  customDocsEmail: string | null;
}>;

/**
 * Update the carrier profile.
 *
 * Records only the fields that actually changed. An event saying "updated the
 * carrier profile (legalName, dbaName, mcNumber, …)" when one character of the
 * address moved is noise, and a timeline of noise is a timeline nobody reads —
 * which defeats guardrail 6 as thoroughly as having no log.
 */
export async function updateCarrierProfile(
  s: Scope,
  input: UpdateCarrierProfileInput,
): Promise<CarrierProfile> {
  return withTransaction(s, async (tx) => {
    const current = await getCarrierProfile(tx);
    if (!current) {
      throw new OnboardingError(
        `no carrier profile for org ${tx.ctx.orgId}`,
        'This account has no carrier profile yet.',
      );
    }

    const changed = (Object.keys(input) as Array<keyof UpdateCarrierProfileInput>).filter(
      (k) => input[k] !== undefined && input[k] !== current[k as keyof CarrierProfile],
    );

    if (changed.length === 0) return current;

    const [row] = await tx.db
      .update(carrierProfiles)
      .set(input)
      .where(eq(carrierProfiles.orgId, tx.ctx.orgId))
      .returning();
    if (!row) throw new Error('carrier profile update returned nothing');

    await recordEvent(tx, 'org.profile_updated', {
      subjectId: tx.ctx.orgId,
      payload: { changed: changed as string[] },
    });

    return row;
  });
}

// ---------------------------------------------------------------------------
// Operating facts
// ---------------------------------------------------------------------------

export type OperatingFactsRecord = Record<string, number | undefined>;

/**
 * Merge operating facts.
 *
 * A merge rather than a replace, because the carrier fills these in across
 * sittings — typically once at signup and again after the import gives them
 * real numbers to check against. A PUT that replaced the object would silently
 * blank the fields not present in the request.
 */
export async function saveOperatingFacts(
  s: Scope,
  facts: OperatingFactsRecord,
  opts: { completeForScoring: boolean },
): Promise<OperatingFactsRecord> {
  return withTransaction(s, async (tx) => {
    const current = await getCarrierProfile(tx);
    if (!current) {
      throw new OnboardingError(
        `no carrier profile for org ${tx.ctx.orgId}`,
        'This account has no carrier profile yet.',
      );
    }

    const existing = (current.operatingFacts ?? {}) as OperatingFactsRecord;
    const merged: OperatingFactsRecord = { ...existing };
    const changed: string[] = [];

    for (const [key, value] of Object.entries(facts)) {
      if (value === undefined) continue;
      if (existing[key] !== value) changed.push(key);
      merged[key] = value;
    }

    if (changed.length === 0) return existing;

    await tx.db
      .update(carrierProfiles)
      .set({ operatingFacts: merged })
      .where(eq(carrierProfiles.orgId, tx.ctx.orgId));

    await recordEvent(tx, 'org.operating_facts_updated', {
      subjectId: tx.ctx.orgId,
      payload: { changed, completeForScoring: opts.completeForScoring },
    });

    return merged;
  });
}

/**
 * Mark the facts as reconciled against imported history.
 *
 * Phase 0's exit gate, and the moment scoring stops running on estimates. It
 * gets its own function and its own event because it is a claim about evidence,
 * not a value: the timestamp says these numbers were checked against `loadCount`
 * real loads, and anything reading `operating_facts` later can tell the
 * difference between a figure that was typed and one that was verified.
 */
export async function markOperatingFactsReconciled(
  s: Scope,
  evidence: { loadCount: number; periodDays: number },
): Promise<void> {
  await withTransaction(s, async (tx) => {
    await tx.db
      .update(carrierProfiles)
      .set({ operatingFactsReconciledAt: new Date() })
      .where(eq(carrierProfiles.orgId, tx.ctx.orgId));

    await recordEvent(tx, 'org.operating_facts_reconciled', {
      subjectId: tx.ctx.orgId,
      payload: evidence,
    });
  });
}
