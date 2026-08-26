/**
 * Tenancy.
 *
 * ADR-0002 chose to extend the dispatcher's existing schema rather than rebuild
 * around it. The concrete consequence is here: the dispatcher's `carriers` table
 * becomes `orgs` plus `carrier_profiles`. Every `carrier_id` in the dispatcher
 * schema maps to `org_id` one-to-one, so the port is a rename plus a backfill,
 * not a restructure.
 *
 * `users` are global, not tenant-scoped. A driver who moves between two
 * carriers on the platform is one person with two memberships, and an owner who
 * runs two authorities is one login. Making users tenant-scoped would force a
 * second account for both cases, which is the sort of thing carriers notice
 * immediately and forgive slowly.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, pk, timestamps } from './_shared.ts';
import {
  membershipStatusEnum,
  orgRoleEnum,
  orgStatusEnum,
  orgTypeEnum,
} from './enums.ts';

/** A tenant. One authority, one billing relationship, one set of records. */
export const orgs = pgTable(
  'orgs',
  {
    id: pk(),
    type: orgTypeEnum('type').notNull().default('carrier'),
    status: orgStatusEnum('status').notNull().default('trialing'),

    /** Legal name. The DBA, if different, lives on `carrier_profiles`. */
    name: text('name').notNull(),
    /** URL-safe handle. Used in paths before we have vanity domains. */
    slug: text('slug').notNull(),

    /** Where system mail goes. Not necessarily any user's address. */
    contactEmail: text('contact_email').notNull(),
    contactPhone: text('contact_phone'),

    /**
     * Domain HaulQ sends broker mail from on this org's behalf. Null until
     * SPF/DKIM/DMARC verify. Nothing may send from it while null.
     */
    sendingDomain: text('sending_domain'),
    sendingDomainVerifiedAt: timestamp('sending_domain_verified_at', {
      withTimezone: true,
    }),

    /**
     * Which products this org has bought. Read on every request, so it lives
     * here rather than behind a join to a billing service.
     * e.g. `{"dispatch":true,"docs":true,"pay":false}`
     */
    entitlements: jsonb('entitlements').notNull().default(sql`'{}'::jsonb`),

    /**
     * Per-tenant spend ceiling for model and vendor calls, per month. Build
     * plan section 7 makes this a precondition for Autopilot; having the column
     * from day one means the cap can be enforced before the feature that needs
     * it ships. Null means "platform default".
     */
    ...money('monthlyUsageCap'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('orgs_slug_key').on(t.slug),
    index('orgs_status_idx').on(t.status),
  ],
);

/**
 * A person. Identity is Clerk's; this row is the local projection plus the
 * things Clerk should not hold.
 */
export const users = pgTable(
  'users',
  {
    id: pk(),
    /** Clerk `user_...`. The join key for every authenticated request. */
    externalAuthId: text('external_auth_id').notNull(),
    email: text('email').notNull(),
    fullName: text('full_name'),
    phone: text('phone'),

    /** IANA zone. Drives HOS clocks and appointment windows, so it is not cosmetic. */
    timezone: text('timezone').notNull().default('America/Chicago'),

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    /**
     * Identity is the external id, and only the external id.
     *
     * `email` is deliberately **not** unique. It is a mutable attribute owned by
     * Clerk, and enforcing uniqueness on it here turns their legitimate states
     * into our constraint violations: two accounts sharing an address across
     * sign-in methods, a person re-registering after deleting an account, or
     * simply the window during an email change where old and new both exist.
     * Every one of those would fail a webhook or a sign-in, at the moment a
     * carrier is least able to tolerate it.
     *
     * Nothing matches on email, so the uniqueness bought nothing. The plain
     * index is for looking a user up by address, which support will want.
     */
    uniqueIndex('users_external_auth_id_key').on(t.externalAuthId),
    index('users_email_idx').on(t.email),
  ],
);

/**
 * The join, and the thing every authorization check reads.
 *
 * A user's role is per-org. The same person can be `owner` at one carrier and
 * `driver` at another.
 */
export const orgMemberships = pgTable(
  'org_memberships',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('driver'),
    status: membershipStatusEnum('status').notNull().default('invited'),

    invitedByUserId: uuid('invited_by_user_id'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    unique('org_memberships_org_user_key').on(t.orgId, t.userId),
    index('org_memberships_user_idx').on(t.userId),
    index('org_memberships_org_role_idx').on(t.orgId, t.role),
  ],
);

/**
 * Pending invitations.
 *
 * A separate table from `org_memberships`, not a row in it with a null user.
 * Three reasons, in order of how much they would hurt:
 *
 *  1. **You invite an email, not a user.** The person may have no HaulQ account
 *     yet — that is the common case for a driver. `org_memberships.user_id` is
 *     `not null` because every authorization check joins through it, and making
 *     it nullable to accommodate invitations would weaken the one column the
 *     access model depends on.
 *
 *  2. **Invitations have their own lifecycle.** They expire, get revoked, get
 *     re-sent. Memberships do none of those things.
 *
 *  3. **Every membership query would need a status filter.** Forget it once and
 *     an invited-but-not-accepted person counts as a member — which is how
 *     someone reads a carrier's loads before accepting anything.
 *
 * The token is stored hashed. A leaked database should not hand over the ability
 * to join a carrier's account, which is the same principle as
 * `board_credentials` keeping a pointer rather than a secret.
 */
export const orgInvitations = pgTable(
  'org_invitations',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /** Where the invitation was sent. Lower-cased on write. */
    email: text('email').notNull(),
    role: orgRoleEnum('role').notNull().default('driver'),

    /** sha256 of the token, hex. The token itself is only ever in the link. */
    tokenHash: text('token_hash').notNull(),

    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** Set when the person accepted. Not necessarily matching `email`. */
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('org_invitations_token_key').on(t.tokenHash),
    index('org_invitations_org_idx').on(t.orgId),
    /**
     * One live invitation per address per org. Partial, so a revoked or accepted
     * invitation does not block re-inviting someone later — which happens
     * whenever a driver leaves and comes back.
     */
    uniqueIndex('org_invitations_org_email_pending_key')
      .on(t.orgId, t.email)
      .where(sql`accepted_at is null and revoked_at is null`),
  ],
);

/**
 * The carrier-specific facts. Split from `orgs` because a broker tenant has no
 * MC number and a nullable column that is mandatory for 100% of real rows is a
 * validation rule pretending to be a schema.
 *
 * Note what is *not* here: insurance status, authority status, safety rating.
 * Those are Verify's output, they carry a source and a timestamp, and
 * guardrail 3 forbids treating a cached copy as current. They get their own
 * table in Phase 0b.
 */
export const carrierProfiles = pgTable(
  'carrier_profiles',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    legalName: text('legal_name').notNull(),
    dbaName: text('dba_name'),
    /** Digits only, no "MC-" prefix. Normalize on write. */
    mcNumber: text('mc_number'),
    usdotNumber: text('usdot_number'),
    einLast4: text('ein_last4'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country').notNull().default('US'),

    /**
     * The address a carrier hands out to brokers instead of the shared
     * `docs+{slug}@docs.haulq.ai` one — e.g. `docs@theircarrier.com`.
     *
     * Not itself an inbound address HaulQ receives on. Postmark only accepts
     * mail for domains it has been configured to receive, one domain per
     * inbound stream, so giving every carrier a native address on their own
     * domain would mean a dedicated mail server per tenant. Instead this is
     * informational: the carrier sets up a forwarding rule on their own mail
     * provider from this address to the `docs+{slug}@...` one, and the
     * existing plus-addressing resolution in the Postmark inbound webhook
     * handles the rest unchanged — a forwarded message still carries
     * `MailboxHash`. Purely a record of what the carrier told HaulQ they
     * configured; nothing here verifies the forward actually exists.
     */
    customDocsEmail: text('custom_docs_email'),

    /**
     * Operating facts the scoring engine needs and nobody can guess: cost per
     * mile, fixed weekly cost, fuel economy, target margin. Phase 0's exit gate
     * is a carrier reconciling these against 30–90 days of imported loads.
     * Loose jsonb until Phase 1c shows which of them Insights actually uses.
     */
    operatingFacts: jsonb('operating_facts').notNull().default(sql`'{}'::jsonb`),
    operatingFactsReconciledAt: timestamp('operating_facts_reconciled_at', {
      withTimezone: true,
    }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('carrier_profiles_org_key').on(t.orgId),
    index('carrier_profiles_mc_idx').on(t.mcNumber),
    index('carrier_profiles_usdot_idx').on(t.usdotNumber),
  ],
);

/**
 * A connected board or ELD provider. No secret material in plain text, ever
 * — two different shapes of that promise sit side by side here:
 *
 *  - **`secretRef`** — a pointer into the secrets manager (Doppler), for a
 *    credential a human hands over once: a DAT username and password. Set
 *    by hand today; nothing in this codebase writes it programmatically.
 *    Inherited verbatim from the dispatcher schema's design note.
 *
 *  - **`encryptedAccessToken` / `encryptedRefreshToken`** — for an OAuth
 *    connection (Motive, Phase 2b), where the token is minted at connect
 *    time and rotated automatically every couple of hours with no human in
 *    the loop. Doppler is built for a person or a deploy managing config,
 *    not a running server writing a new secret every two hours, so these
 *    are sealed directly in this row instead — `crypto_box_seal` from
 *    `credential-crypto.ts`, encrypted with `CREDENTIAL_ENCRYPTION_PUBLIC_KEY`
 *    at write time, decryptable only by whoever holds
 *    `CREDENTIAL_ENCRYPTION_PRIVATE_KEY`. A leaked database alone still
 *    hands over nothing — the same guarantee `secretRef` makes, kept a
 *    different way because an OAuth token cannot be a Doppler *path*, it
 *    has to be the credential itself, somewhere.
 *
 * One row is always exactly one shape or the other — see
 * `board_credentials_has_a_secret` in `sql/post/0500_constraints.sql`.
 * `board` is text rather than an enum because the set grows on someone
 * else's schedule.
 */
export const boardCredentials = pgTable(
  'board_credentials',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    board: text('board').notNull(),
    /** Doppler / secrets-manager path. Opaque to this database. Null for an OAuth connection. */
    secretRef: text('secret_ref'),
    /** Which board user searches run as, for the provider's audit trail. */
    endUserEmail: text('end_user_email'),

    /** Sealed with `CREDENTIAL_ENCRYPTION_PUBLIC_KEY`. Null for a secretRef-shaped row. */
    encryptedAccessToken: text('encrypted_access_token'),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    /** When `encryptedAccessToken` stops being usable and needs the refresh token. */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),

    status: text('status').notNull().default('unverified'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastError: text('last_error'),

    /** True when the carrier brought their own seat. See build plan section 7. */
    carrierOwnedSeat: boolean('carrier_owned_seat').notNull().default(false),

    ...timestamps,
  },
  (t) => [unique('board_credentials_org_board_key').on(t.orgId, t.board)],
);

// --- relations -------------------------------------------------------------

export const orgsRelations = relations(orgs, ({ one, many }) => ({
  carrierProfile: one(carrierProfiles),
  memberships: many(orgMemberships),
  boardCredentials: many(boardCredentials),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(orgMemberships),
}));

export const orgMembershipsRelations = relations(orgMemberships, ({ one }) => ({
  org: one(orgs, { fields: [orgMemberships.orgId], references: [orgs.id] }),
  user: one(users, { fields: [orgMemberships.userId], references: [users.id] }),
}));

export const carrierProfilesRelations = relations(carrierProfiles, ({ one }) => ({
  org: one(orgs, { fields: [carrierProfiles.orgId], references: [orgs.id] }),
}));

export const boardCredentialsRelations = relations(boardCredentials, ({ one }) => ({
  org: one(orgs, { fields: [boardCredentials.orgId], references: [orgs.id] }),
}));
