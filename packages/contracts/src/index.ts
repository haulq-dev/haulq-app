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
export * from './classify.ts';
export * from './csv.ts';
export * from './documents.ts';
export * from './extract.ts';
export * from './import-mapping.ts';
export * from './operating-facts.ts';
export * from './validate.ts';

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

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/**
 * The state machine, mirrored from `sql/post/0300_load_status.sql`.
 *
 * **The database is the enforcement; this is display truth.** The same column
 * is written by Docs, Pay, Dispatch and the driver app, which is why the rule
 * lives in a trigger rather than in one service's code. Duplicating the
 * ordinals here buys one thing: the UI can grey out a transition instead of
 * offering it and surfacing a constraint violation.
 *
 * If these two ever disagree, the trigger wins and this file is the bug.
 */
export const LOAD_STATUSES = [
  'prospect',
  'quoted',
  'booked',
  'dispatched',
  'in_transit',
  'delivered',
  'invoiced',
  'paid',
  'cancelled',
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

const STATUS_ORDINAL: Record<LoadStatus, number> = {
  prospect: 10,
  quoted: 20,
  booked: 30,
  dispatched: 40,
  in_transit: 50,
  delivered: 60,
  invoiced: 70,
  paid: 80,
  cancelled: 90,
};

export const LOAD_SOURCES = [
  'load_board',
  'broker_email',
  'manual',
  'csv_import',
  'api',
] as const;
export type LoadSource = (typeof LOAD_SOURCES)[number];

export const STOP_TYPES = ['pickup', 'delivery'] as const;
export type StopType = (typeof STOP_TYPES)[number];

export interface TransitionCheck {
  allowed: boolean;
  /** Present when not allowed. The sentence a carrier should read. */
  reason?: string;
}

/**
 * Whether a status change is legal.
 *
 * Skips are legal on purpose. A carrier booking straight from a broker email
 * goes prospect → booked with nothing quoted, and a short local run can go
 * delivered → paid the same afternoon on a quick-pay. Forbidding skips would
 * make the application invent intermediate states to satisfy the constraint,
 * which teaches everyone the states are decorative.
 */
export function canTransition(from: LoadStatus, to: LoadStatus): TransitionCheck {
  if (from === to) return { allowed: true };

  if (to === 'cancelled') {
    return from === 'paid'
      ? {
          allowed: false,
          reason: 'This load has been paid. Record a reversal rather than cancelling it.',
        }
      : { allowed: true };
  }

  if (from === 'cancelled') {
    return {
      allowed: false,
      reason: 'This load was cancelled. Reopening is not supported — create a new load.',
    };
  }

  if (STATUS_ORDINAL[to] < STATUS_ORDINAL[from]) {
    return {
      allowed: false,
      reason: `A load cannot move backwards from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}.`,
    };
  }

  return { allowed: true };
}

/** Statuses reachable from `from`, for building a menu that offers no dead ends. */
export function nextStatuses(from: LoadStatus): LoadStatus[] {
  return LOAD_STATUSES.filter((s) => s !== from && canTransition(from, s).allowed);
}

/**
 * Which timestamp a status requires.
 *
 * `0300_load_status.sql` adds check constraints for these, so a load that
 * reaches `booked` with a null `booked_at` is rejected by the database rather
 * than discovered months later in an Insights query. The repository fills them
 * in; this map is what tells it which.
 */
export const STATUS_TIMESTAMP: Partial<Record<LoadStatus, 'bookedAt' | 'deliveredAt' | 'cancelledAt'>> = {
  booked: 'bookedAt',
  delivered: 'deliveredAt',
  cancelled: 'cancelledAt',
};

/** True once a load needs a truck named. `csv_import` is exempt — see the SQL. */
export function requiresTruck(status: LoadStatus, source: LoadSource): boolean {
  if (source === 'csv_import') return false;
  if (status === 'cancelled') return false;
  return STATUS_ORDINAL[status] >= STATUS_ORDINAL.dispatched;
}

const StopBase = z.object({
  type: z.enum(STOP_TYPES),
  facilityName: z.string().max(200).optional(),
  addressLine1: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: StateCode,
  postalCode: z.string().max(12).optional(),
  /**
   * Both ends optional, and that is deliberate. Boards routinely post a date
   * with no time, and inventing "00:00" would make an HOS feasibility check in
   * Phase 3 confidently wrong rather than merely unknown.
   */
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  appointmentRequired: z.boolean().default(false),
  appointmentNumber: z.string().max(60).optional(),
  referenceNumber: z.string().max(60).optional(),
  instructions: z.string().max(2000).optional(),
});

export const CreateStopSchema = StopBase.superRefine((stop, ctx) => {
  if (stop.windowStart && stop.windowEnd && stop.windowEnd < stop.windowStart) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['windowEnd'],
      message: 'The window ends before it starts.',
    });
  }
});
export type CreateStop = z.infer<typeof CreateStopSchema>;

export const CreateLoadSchema = z
  .object({
    source: z.enum(LOAD_SOURCES).default('manual'),
    status: z.enum(LOAD_STATUSES).default('prospect'),

    brokerName: z.string().max(200).optional(),
    brokerLoadNumber: z.string().max(60).optional(),

    equipment: EquipmentTypeSchema.default('STRAIGHT_BOX'),
    commodity: z.string().max(200).optional(),
    weightLbs: z.number().int().positive().max(80_000).optional(),
    pieceCount: z.number().int().positive().max(10_000).optional(),
    fullLoad: z.boolean().default(true),
    hazmat: z.boolean().default(false),
    comments: z.string().max(4000).optional(),

    rate: MoneySchema.optional(),
    /** All-in unless this is set. The distinction the whole product turns on. */
    rateIsLinehaul: z.boolean().default(false),

    expectedDeadheadMiles: z.number().int().min(0).max(5_000).optional(),
    expectedLoadedMiles: z.number().int().min(0).max(5_000).optional(),

    truckId: z.string().uuid().optional(),
    driverId: z.string().uuid().optional(),

    /**
     * At least one pickup and one delivery.
     *
     * Not an arbitrary minimum: a load with no destination is not a load, and
     * `load.created`'s sentence names both. Stops are rows rather than
     * origin/dest columns (decision 2) so a two-stop delivery works today
     * without a migration.
     */
    stops: z.array(StopBase).min(2),
  })
  .superRefine((load, ctx) => {
    if (!load.stops.some((s) => s.type === 'pickup')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stops'],
        message: 'A load needs at least one pickup.',
      });
    }
    if (!load.stops.some((s) => s.type === 'delivery')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stops'],
        message: 'A load needs at least one delivery.',
      });
    }
    if (requiresTruck(load.status, load.source) && !load.truckId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['truckId'],
        message: `A load at ${load.status.replace('_', ' ')} has to name the truck running it.`,
      });
    }
  });
export type CreateLoad = z.infer<typeof CreateLoadSchema>;

export const UpdateLoadStatusSchema = z.object({
  status: z.enum(LOAD_STATUSES),
  /** Required when cancelling. A cancellation with no reason is unauditable. */
  reason: z.string().max(500).optional(),
  /** Backdating, for a delivery recorded the next morning. */
  occurredAt: z.string().datetime().optional(),
});

export const AssignLoadSchema = z.object({
  truckId: z.string().uuid().nullable(),
  driverId: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------
//
// Same split as Loads above: the database is the enforcement (the invoice
// status trigger in `sql/post/0700_invoice_status.sql`, the partial unique
// index that allows one open invoice per load), this is display truth plus
// the shape a request body has to match before it reaches a repository
// function at all.

/** Mirrors `invoice_status` in `schema/enums.ts`. */
export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

const INVOICE_STATUS_ORDINAL: Record<InvoiceStatus, number> = {
  draft: 10,
  sent: 20,
  paid: 30,
  void: 40,
};

/**
 * Whether an invoice status change is legal — same reasoning as
 * `canTransition` above: the trigger is the enforcement, this lets a screen
 * grey out a dead-end instead of offering it and showing a raw refusal.
 */
export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): TransitionCheck {
  if (from === to) return { allowed: true };

  if (to === 'void') {
    return from === 'paid'
      ? {
          allowed: false,
          reason: 'This invoice is paid. Record a reversal rather than voiding it.',
        }
      : { allowed: true };
  }

  if (from === 'void') {
    return {
      allowed: false,
      reason: 'This invoice was voided. Generate a new one to reissue it.',
    };
  }

  if (INVOICE_STATUS_ORDINAL[to] < INVOICE_STATUS_ORDINAL[from]) {
    return { allowed: false, reason: `An invoice cannot move backwards from ${from} to ${to}.` };
  }

  return { allowed: true };
}

/**
 * Linehaul, fuel surcharge, detention, TONU, lumper — one row per
 * accessorial. `code` is free text with no enum on the wire either, same
 * reasoning as `documents.kind`: the tail of things a carrier bills for is
 * long and grows on its own schedule.
 */
export const InvoiceLineItemSchema = z.object({
  code: z.string().min(1).max(60),
  description: z.string().min(1).max(300),
  amountCents: z.number().int(),
  currency: z.string().length(3).optional(),
});
export type InvoiceLineItem = z.infer<typeof InvoiceLineItemSchema>;

export const GenerateInvoiceSchema = z.object({
  loadId: z.string().uuid(),
  lineItems: z.array(InvoiceLineItemSchema).min(1),
  sourceDocumentId: z.string().uuid().optional(),
  /** Overrides the due date computed from the broker's payment terms. */
  dueAt: z.string().datetime().optional(),
});
export type GenerateInvoice = z.infer<typeof GenerateInvoiceSchema>;

export const VoidInvoiceSchema = z.object({
  reason: z.string().min(1).max(500),
});

/** Mirrors `factoring_packet_status` in `schema/enums.ts`. */
export const FACTORING_PACKET_STATUSES = [
  'assembling',
  'submitted',
  'accepted',
  'rejected',
  'funded',
] as const;
export type FactoringPacketStatus = (typeof FACTORING_PACKET_STATUSES)[number];

export const FACTORING_SUBMISSION_METHODS = ['email', 'portal', 'api'] as const;

export const CreateFactoringCompanySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  submissionMethod: z.enum(FACTORING_SUBMISSION_METHODS).default('email'),
  notes: z.string().max(2000).optional(),
});
export type CreateFactoringCompany = z.infer<typeof CreateFactoringCompanySchema>;

export const AssembleFactoringPacketSchema = z.object({
  invoiceId: z.string().uuid(),
  factoringCompanyId: z.string().uuid(),
  /** Which of the load's `documents` rows to bundle. Often empty at first —
   *  an invoice with no supporting paperwork attached yet is still a packet
   *  worth starting, not an error. */
  documentIds: z.array(z.string().uuid()).default([]),
});
export type AssembleFactoringPacket = z.infer<typeof AssembleFactoringPacketSchema>;

export const FactoringResponseSchema = z
  .object({
    outcome: z.enum(['accepted', 'rejected']),
    reason: z.string().max(500).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.outcome === 'rejected' && !input.reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Say why the factor rejected this packet.',
      });
    }
  });
export type FactoringResponse = z.infer<typeof FactoringResponseSchema>;

export const PAYMENT_SOURCES = ['factor', 'broker_direct'] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const RecordPaymentSchema = z.object({
  amount: MoneySchema,
  source: z.enum(PAYMENT_SOURCES),
  /** Overrides `now()`, for a deposit recorded the day after it cleared. */
  receivedAt: z.string().datetime().optional(),
  reference: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  /** When this money settles a specific factoring submission. */
  factoringPacketId: z.string().uuid().optional(),
});
export type RecordPayment = z.infer<typeof RecordPaymentSchema>;
