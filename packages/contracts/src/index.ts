/**
 * The wire contract between apps/api and apps/web.
 *
 * Deliberately thin at Phase 0. It holds the primitives that more than one
 * surface has to agree on — money, tenant identity, pagination — and nothing
 * else. Endpoint schemas arrive with the endpoints.
 *
 * The stack table picks tRPC for the internal contract. That is not wired yet:
 * tRPC's value is inferring these types across the boundary, and there is
 * nothing to infer until there are procedures. Adding it now would be
 * configuration with no caller.
 */

import { z } from 'zod';

export * from './coerce.ts';
export * from './csv.ts';
export * from './import-mapping.ts';
export * from './operating-facts.ts';

/**
 * Money on the wire.
 *
 * Same shape as the database and the same shape dinero.js takes, so an amount
 * crosses three boundaries without a rounding step. `amount` is minor units.
 * Build plan section 5: never floats near an invoice.
 */
export const MoneySchema = z.object({
  amount: z.number().int(),
  currency: z.string().length(3).default('USD'),
});
export type Money = z.infer<typeof MoneySchema>;

export const OrgIdSchema = z.string().uuid();
export const UserIdSchema = z.string().uuid();

/**
 * Cursor pagination, not offset.
 *
 * A carrier's load list is written to while it is read. Offset pagination
 * silently skips and repeats rows when that happens, which looks like data loss
 * to the person holding the phone.
 */
export const PageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

/**
 * Error envelope.
 *
 * `explanation` is not decoration. Guardrail 6 requires human-readable
 * explanations and section 8 sells explainable control; a UI that has to invent
 * prose from an error code will invent it inconsistently.
 */
export const ApiErrorSchema = z.object({
  code: z.string(),
  explanation: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export const EquipmentTypeSchema = z.enum([
  'STRAIGHT_BOX',
  'DRY_VAN',
  'REEFER',
  'FLATBED',
  'POWER_ONLY',
  'OTHER',
]);

/**
 * What a truck can do beyond carrying weight.
 *
 * The field list is lifted from the dispatcher's `SettingsForm`, which had
 * already worked out which capabilities actually gate freight. Its own note is
 * the justification: a missing liftgate flag hides every load that mentions
 * one, and it fails silently.
 */
export const TruckCapabilitiesSchema = z.object({
  liftgate: z.boolean().optional(),
  palletJack: z.boolean().optional(),
  driverAssist: z.boolean().optional(),
  twicCard: z.boolean().optional(),
  hazmatEndorsement: z.boolean().optional(),
  securementGear: z.boolean().optional(),
  dockHigh: z.boolean().optional(),
  teamDrivers: z.boolean().optional(),
});
export type TruckCapabilities = z.infer<typeof TruckCapabilitiesSchema>;

export const CreateTruckSchema = z.object({
  label: z.string().min(1).max(80),
  equipment: EquipmentTypeSchema.default('STRAIGHT_BOX'),
  maxWeightLbs: z.number().int().positive().max(80_000).optional(),
  maxLengthFt: z.number().int().positive().max(100).optional(),
  capabilities: TruckCapabilitiesSchema.default({}),
  /**
   * Straight trucks frequently run under the 150 air-mile short-haul exemption,
   * which is why ELD coverage is patchy for them (build plan section 13). Asked
   * at creation rather than inferred, because which position fallback applies
   * depends on the answer.
   */
  shortHaulExempt: z.boolean().default(false),
});
export type CreateTruck = z.infer<typeof CreateTruckSchema>;

export const TruckSchema = CreateTruckSchema.extend({
  id: z.string().uuid(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type Truck = z.infer<typeof TruckSchema>;

// ---------------------------------------------------------------------------
// Org and carrier profile
// ---------------------------------------------------------------------------

/** Two-letter US state code, upper-cased. */
const StateCode = z
  .string()
  .length(2)
  .transform((s) => s.toUpperCase());

/**
 * MC and USDOT numbers, digits only.
 *
 * Carriers write these half a dozen ways — "MC-123456", "MC 123456", "123456".
 * Normalizing on the way in means the FMCSA lookup in Phase 0b has one format
 * to handle, and `brokers.mc_number` can be joined on without a cleanup pass.
 */
const DocketNumber = z
  .string()
  .transform((s) => s.replace(/\D/g, ''))
  .pipe(z.string().min(4).max(9));

export const CreateOrgSchema = z.object({
  /** Legal name on the authority. The DBA goes on the carrier profile. */
  name: z.string().min(1).max(200),
  contactEmail: z.string().email(),
  contactPhone: z.string().max(40).optional(),
  mcNumber: DocketNumber.optional(),
  usdotNumber: DocketNumber.optional(),
});
export type CreateOrg = z.infer<typeof CreateOrgSchema>;

export const UpdateCarrierProfileSchema = z.object({
  legalName: z.string().min(1).max(200).optional(),
  dbaName: z.string().max(200).nullable().optional(),
  mcNumber: DocketNumber.nullable().optional(),
  usdotNumber: DocketNumber.nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: StateCode.nullable().optional(),
  postalCode: z.string().max(12).nullable().optional(),
});
export type UpdateCarrierProfile = z.infer<typeof UpdateCarrierProfileSchema>;

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/**
 * Endorsements that gate freight.
 *
 * Matched against requirements extracted from broker comments — "TWIC required
 * for port pickup" is the canonical case, and it is invisible to every numeric
 * filter on every load board.
 */
export const ENDORSEMENTS = [
  'hazmat',
  'tanker',
  'doubles_triples',
  'twic',
  'passenger',
] as const;

export const CreateDriverSchema = z.object({
  fullName: z.string().min(1).max(120),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  cdlNumber: z.string().max(40).optional(),
  cdlState: StateCode.optional(),
  cdlExpiresAt: z.string().datetime().optional(),
  medicalCardExpiresAt: z.string().datetime().optional(),
  endorsements: z.array(z.enum(ENDORSEMENTS)).default([]),
  defaultTruckId: z.string().uuid().optional(),
});
export type CreateDriver = z.infer<typeof CreateDriverSchema>;

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * One line of the audit trail.
 *
 * `explanation` is the field the UI renders. `verb` is for filtering and
 * icons — never for building a sentence, because that is how the log ends up
 * saying different things in different screens.
 *
 * Note what is absent: `hash` and `prevHash`. They are tamper evidence, not
 * content, and a client validating a chain against one page of results would
 * conclude it is broken.
 */
export const TimelineEntrySchema = z.object({
  seq: z.string(), // bigint, serialized — JSON numbers lose precision past 2^53
  occurredAt: z.string(),
  verb: z.string(),
  subjectType: z.string(),
  subjectId: z.string().uuid().nullable(),
  explanation: z.string(),
  actorType: z.enum(['user', 'agent', 'system', 'integration']),
  actorId: z.string().nullable(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
