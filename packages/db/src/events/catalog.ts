/**
 * The event catalogue.
 *
 * Every event HaulQ can record is declared here, with the shape of its payload
 * and — the part that matters — a function that turns that payload into a
 * sentence a carrier can read.
 *
 * ---------------------------------------------------------------------------
 * Why the explanation is a function in a registry, not a string at the call site
 * ---------------------------------------------------------------------------
 *
 * Guardrail 6 requires human-readable explanations, and section 8 sells
 * explainable control as a place HaulQ wins. Left to call sites, that decays in
 * a predictable way: the first writer produces "Booked load 1042 with Acme
 * Logistics at $2,400", the fifth produces "status changed", and by the time
 * anyone notices, the log has two years of rows in a dozen registers and no way
 * to fix the old ones — `event_log` is append-only by design.
 *
 * Declaring it here makes the sentence part of the event's definition. Adding a
 * verb without one does not compile, and improving the phrasing is one edit
 * rather than a search across the codebase.
 *
 * Keep the sentences specific and past-tense. "Recommended load 1042 because it
 * clears $1.94/total mile against your $1.60 floor" is the bar. "Score 72" is
 * not: it is the input to an explanation, not an explanation.
 */

/** Formats minor units for prose. 240000 → "$2,400.00". */
export function formatMoney(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount / 100);
}

/** "Wichita, KS". */
export function formatPlace(city: string, state: string): string {
  return `${city}, ${state}`;
}

/** How a load is named in prose. Carriers say "load 1042", never a uuid. */
export function formatLoad(reference: number): string {
  return `load ${reference}`;
}

/** Same idea as `formatLoad`, for the number on a factoring packet's cover sheet. */
export function formatInvoice(reference: number): string {
  return `invoice ${reference}`;
}

/**
 * One event's definition: what it is about, and how to describe it.
 *
 * `subjectType` is fixed per verb rather than passed in, because a verb that can
 * be about two different kinds of thing is two verbs.
 */
export interface EventDefinition<Payload> {
  subjectType: string;
  describe: (payload: Payload) => string;
  /**
   * Outbox topic, when something must happen as a consequence. Omitted for
   * events that are purely a record.
   *
   * The outbox row is written in the same transaction as the event, so a
   * consequence is never triggered for a change that rolled back.
   */
  topic?: string;
}

const define = <P>(d: EventDefinition<P>) => d;

/**
 * Phase 0's verbs.
 *
 * Deliberately small. Each phase adds its own, and a verb with no writer is
 * a guess about what a future feature will want to say.
 */
export const eventCatalog = {
  // --- org and membership ------------------------------------------------

  'org.created': define<{ name: string }>({
    subjectType: 'org',
    describe: (p) => `Created the ${p.name} account on HaulQ.`,
  }),

  'org.profile_updated': define<{ changed: string[] }>({
    subjectType: 'org',
    describe: (p) => `Updated the carrier profile (${p.changed.join(', ')}).`,
  }),

  'org.operating_facts_updated': define<{
    changed: string[];
    completeForScoring: boolean;
  }>({
    subjectType: 'org',
    // Says what the change unlocked, not just that it happened. Until these are
    // complete, every margin figure HaulQ shows is an estimate built on a
    // default, and the carrier deserves to know which state they are in.
    describe: (p) =>
      `Updated operating costs (${p.changed.join(', ')}). ` +
      (p.completeForScoring
        ? 'Margin estimates now use your figures.'
        : 'Margin estimates still use defaults until cost per mile and fixed weekly cost are both set.'),
  }),

  'org.operating_facts_reconciled': define<{
    loadCount: number;
    periodDays: number;
  }>({
    subjectType: 'org',
    // Phase 0's exit gate. Worth an event of its own: it is the moment the
    // scoring engine stops running on guesses.
    describe: (p) =>
      `Reconciled operating costs against ${p.loadCount} loads over the last ` +
      `${p.periodDays} days. Scoring now uses measured figures rather than estimates.`,
  }),

  /**
   * No `topic` here, deliberately.
   *
   * The email has to contain the invitation link, and the link is the raw
   * token — which this payload does not have and must not have. `event_log` is
   * append-only and kept forever; a live credential written into it could never
   * be removed, only expired around.
   *
   * So `inviteMember` enqueues the `member.invite_email` message itself, in the
   * same transaction, carrying the token. This entry stays the audit record and
   * nothing more. See the note above the enqueue in
   * `repositories/members.ts`.
   */
  'member.invited': define<{ email: string; role: string }>({
    subjectType: 'org',
    describe: (p) => `Invited ${p.email} to join as ${p.role}.`,
  }),

  'member.invite_revoked': define<{ email: string }>({
    subjectType: 'org',
    describe: (p) => `Withdrew the invitation sent to ${p.email}.`,
  }),

  'member.joined': define<{ email: string; role: string }>({
    subjectType: 'org',
    describe: (p) => `${p.email} joined the account as ${p.role}.`,
  }),

  'member.role_changed': define<{ email: string; from: string; to: string }>({
    subjectType: 'org',
    describe: (p) => `Changed ${p.email} from ${p.from} to ${p.to}.`,
  }),

  'member.removed': define<{ email: string }>({
    subjectType: 'org',
    describe: (p) => `Removed ${p.email} from the account.`,
  }),

  // --- fleet ---------------------------------------------------------------

  'truck.added': define<{ label: string; equipment: string }>({
    subjectType: 'truck',
    describe: (p) => `Added ${p.label} (${p.equipment.toLowerCase().replace('_', ' ')}).`,
  }),

  'truck.capabilities_updated': define<{
    label: string;
    added: string[];
    removed: string[];
  }>({
    subjectType: 'truck',
    // Spelled out because this quietly changes which loads are visible, and a
    // carrier wondering "why did the liftgate loads disappear" needs to find
    // this row.
    describe: (p) => {
      const parts: string[] = [];
      if (p.added.length) parts.push(`added ${p.added.join(', ')}`);
      if (p.removed.length) parts.push(`removed ${p.removed.join(', ')}`);
      const change = parts.length ? parts.join(' and ') : 'made no changes';
      return (
        `Updated what ${p.label} can do: ${change}. ` +
        `This changes which loads are matched to it.`
      );
    },
  }),

  'truck.deactivated': define<{ label: string; reason?: string }>({
    subjectType: 'truck',
    describe: (p) =>
      `Took ${p.label} out of service${p.reason ? `: ${p.reason}` : '.'}`,
  }),

  'driver.added': define<{ name: string }>({
    subjectType: 'driver',
    describe: (p) => `Added driver ${p.name}.`,
  }),

  // --- loads ---------------------------------------------------------------

  'load.created': define<{
    reference: number;
    origin: string;
    destination: string;
    source: string;
  }>({
    subjectType: 'load',
    describe: (p) =>
      `Created ${formatLoad(p.reference)}, ${p.origin} to ${p.destination}` +
      `${p.source === 'manual' ? '' : ` (from ${p.source.replace('_', ' ')})`}.`,
  }),

  'load.booked': define<{
    reference: number;
    brokerName: string;
    rateAmount: number;
    rateCurrency: string;
  }>({
    subjectType: 'load',
    describe: (p) =>
      `Booked ${formatLoad(p.reference)} with ${p.brokerName} at ` +
      `${formatMoney(p.rateAmount, p.rateCurrency)}.`,
    topic: 'load.booked',
  }),

  'load.assigned': define<{
    reference: number;
    truckLabel: string;
    driverName?: string;
  }>({
    subjectType: 'load',
    describe: (p) =>
      `Assigned ${formatLoad(p.reference)} to ${p.truckLabel}` +
      `${p.driverName ? `, driven by ${p.driverName}` : ''}.`,
  }),

  /**
   * The moves that are not milestones.
   *
   * `quoted`, `dispatched`, `in_transit`, `invoiced` and `paid` do not each
   * earn a verb — five near-identical entries would be five sentences to keep
   * consistent for no gain. But they still belong in the log: guardrail 6 asks
   * for an audit trail, not a highlights reel, and "when did this go to
   * invoiced" is a question Pay will be asked to answer.
   *
   * Both ends are in the payload so the sentence reads without joining back to
   * the row, which matters because the row has moved on since.
   */
  'load.status_changed': define<{ reference: number; from: string; to: string }>({
    subjectType: 'load',
    describe: (p) =>
      `Moved ${formatLoad(p.reference)} from ${p.from.replace('_', ' ')} to ` +
      `${p.to.replace('_', ' ')}.`,
  }),

  'load.delivered': define<{ reference: number; deliveredAt: string }>({
    subjectType: 'load',
    describe: (p) => `Delivered ${formatLoad(p.reference)}.`,
  }),

  'load.cancelled': define<{ reference: number; reason: string }>({
    subjectType: 'load',
    describe: (p) => `Cancelled ${formatLoad(p.reference)}: ${p.reason}`,
  }),

  'load.reconciled': define<{
    reference: number;
    expectedMarginAmount: number;
    actualMarginAmount: number;
    currency: string;
  }>({
    subjectType: 'load',
    // The closed loop from section 8. Naming both numbers in the sentence is
    // the point — the gap is what tunes the scoring.
    describe: (p) => {
      const expected = formatMoney(p.expectedMarginAmount, p.currency);
      const actual = formatMoney(p.actualMarginAmount, p.currency);
      const delta = p.actualMarginAmount - p.expectedMarginAmount;
      const direction =
        delta === 0 ? 'exactly as expected' : delta > 0 ? 'better' : 'worse';
      return (
        `Reconciled ${formatLoad(p.reference)}: expected ${expected}, ` +
        `actually made ${actual} — ${direction} than predicted.`
      );
    },
  }),

  // --- imports -------------------------------------------------------------

  'import.uploaded': define<{ filename: string; rowCount: number }>({
    subjectType: 'import',
    describe: (p) => `Uploaded ${p.filename} with ${p.rowCount} rows.`,
  }),

  'import.committed': define<{
    filename: string;
    committed: number;
    skipped: number;
  }>({
    subjectType: 'import',
    describe: (p) =>
      `Imported ${p.committed} loads from ${p.filename}` +
      `${p.skipped ? `, skipping ${p.skipped} rows with errors` : ''}.`,
    topic: 'import.committed',
  }),

  'import.failed': define<{ filename: string; reason: string }>({
    subjectType: 'import',
    describe: (p) => `Could not import ${p.filename}: ${p.reason}`,
  }),

  // --- documents -----------------------------------------------------------

  'document.received': define<{ kind: string; from: string }>({
    subjectType: 'document',
    describe: (p) => `Received a ${p.kind.replace('_', ' ')} from ${p.from}.`,
    topic: 'document.received',
  }),

  /**
   * Attaching is a human decision often enough to be worth its own verb. A
   * rate confirmation that arrives by email before the load exists gets matched
   * later — by a person, or by a model — and "which document was hung on this
   * load, and by whom" is a question a dispute asks directly.
   */
  'document.attached': define<{ kind: string; loadReference: number }>({
    subjectType: 'document',
    describe: (p) =>
      `Attached the ${p.kind.replace('_', ' ')} to ${formatLoad(p.loadReference)}.`,
  }),

  /**
   * Recorded because guardrail 5 makes a model's reads auditable, not because
   * anything downstream reacts to it — hence no topic. `extractorVersion` is in
   * the sentence so a bad prompt is findable in the log rather than only in a
   * column.
   */
  'document.extracted': define<{
    kind: string;
    fieldCount: number;
    extractorVersion: string;
  }>({
    subjectType: 'document',
    describe: (p) =>
      `Read ${p.fieldCount} ${p.fieldCount === 1 ? 'field' : 'fields'} off the ` +
      `${p.kind.replace('_', ' ')} using ${p.extractorVersion}.`,
  }),

  'document.validated': define<{ kind: string; loadReference: number }>({
    subjectType: 'document',
    describe: (p) =>
      `Checked the ${p.kind.replace('_', ' ')} against ` +
      `${formatLoad(p.loadReference)} and everything agrees.`,
  }),

  'document.rejected': define<{
    kind: string;
    loadReference: number;
    reason: string;
  }>({
    subjectType: 'document',
    describe: (p) =>
      `The ${p.kind.replace('_', ' ')} does not match ` +
      `${formatLoad(p.loadReference)}: ${p.reason}`,
    topic: 'document.rejected',
  }),

  // --- pay -------------------------------------------------------------
  //
  // PHASE_1_PLAN.md section 5's three sentences, each getting the verbs its
  // own state machine needs. `invoice.sent` and `invoice.paid` also move
  // `loads.status` (see `repositories/pay.ts`'s `advanceLoad`), which is why
  // their sentences name the load as well as the invoice — a carrier reading
  // the timeline should not have to cross-reference which load an invoice
  // was for.

  'invoice.generated': define<{
    reference: number;
    loadReference: number;
    totalAmount: number;
    totalCurrency: string;
  }>({
    subjectType: 'invoice',
    describe: (p) =>
      `Generated ${formatInvoice(p.reference)} for ${formatLoad(p.loadReference)}, ` +
      `${formatMoney(p.totalAmount, p.totalCurrency)}.`,
  }),

  'invoice.sent': define<{
    reference: number;
    loadReference: number;
    totalAmount: number;
    totalCurrency: string;
  }>({
    subjectType: 'invoice',
    describe: (p) =>
      `Sent ${formatInvoice(p.reference)} for ${formatLoad(p.loadReference)}, ` +
      `${formatMoney(p.totalAmount, p.totalCurrency)}.`,
  }),

  'invoice.paid': define<{
    reference: number;
    loadReference: number;
    totalAmount: number;
    totalCurrency: string;
  }>({
    subjectType: 'invoice',
    // What "receivables aging" and "payment speed" both resolve against —
    // the moment an invoice's payments finally cover its total.
    describe: (p) =>
      `${formatInvoice(p.reference)} for ${formatLoad(p.loadReference)} is now ` +
      `fully paid: ${formatMoney(p.totalAmount, p.totalCurrency)}.`,
  }),

  'invoice.voided': define<{ reference: number; reason: string }>({
    subjectType: 'invoice',
    describe: (p) => `Voided ${formatInvoice(p.reference)}: ${p.reason}`,
  }),

  'factoring_company.added': define<{ name: string }>({
    subjectType: 'factoring_company',
    describe: (p) => `Added ${p.name} as a factoring company.`,
  }),

  /**
   * A human decision — which of a load's documents go to which factor —
   * worth its own line for the same reason `document.attached` is: a
   * rejected packet gets re-examined later, and "what did we send them" is
   * the first question.
   */
  'factoring_packet.assembled': define<{
    invoiceReference: number;
    factoringCompanyName: string;
    documentCount: number;
  }>({
    subjectType: 'factoring_packet',
    describe: (p) =>
      `Assembled a factoring packet for ${formatInvoice(p.invoiceReference)} — ` +
      `${p.documentCount} ${p.documentCount === 1 ? 'document' : 'documents'} — ` +
      `for ${p.factoringCompanyName}.`,
  }),

  /**
   * `topic` is here for the future the estimate names but this phase does not
   * build: an outbox consumer that emails the packet, the way
   * `document.received` already drives intake and `invite-email.ts` already
   * drives a templated send. Until that consumer exists the row queues and
   * nothing drains it, which is inert, not broken.
   */
  'factoring_packet.submitted': define<{
    invoiceReference: number;
    factoringCompanyName: string;
  }>({
    subjectType: 'factoring_packet',
    describe: (p) =>
      `Submitted ${formatInvoice(p.invoiceReference)} to ${p.factoringCompanyName}.`,
    topic: 'factoring_packet.submitted',
  }),

  'factoring_packet.accepted': define<{
    invoiceReference: number;
    factoringCompanyName: string;
  }>({
    subjectType: 'factoring_packet',
    describe: (p) =>
      `${p.factoringCompanyName} accepted ${formatInvoice(p.invoiceReference)}.`,
  }),

  'factoring_packet.rejected': define<{
    invoiceReference: number;
    factoringCompanyName: string;
    reason: string;
  }>({
    subjectType: 'factoring_packet',
    describe: (p) =>
      `${p.factoringCompanyName} rejected ${formatInvoice(p.invoiceReference)}: ${p.reason}`,
    topic: 'factoring_packet.rejected',
  }),

  'factoring_packet.funded': define<{
    invoiceReference: number;
    factoringCompanyName: string;
    amount: number;
    currency: string;
  }>({
    subjectType: 'factoring_packet',
    describe: (p) =>
      `${p.factoringCompanyName} funded ${formatInvoice(p.invoiceReference)}: ` +
      `${formatMoney(p.amount, p.currency)}.`,
  }),

  'payment.recorded': define<{
    invoiceReference: number;
    amount: number;
    currency: string;
    source: string;
  }>({
    subjectType: 'payment',
    describe: (p) =>
      `Recorded ${formatMoney(p.amount, p.currency)} against ` +
      `${formatInvoice(p.invoiceReference)} from ` +
      `${p.source === 'factor' ? 'the factor' : 'the broker, direct'}.`,
  }),

  // --- credentials ---------------------------------------------------------

  'board_credential.connected': define<{ board: string }>({
    subjectType: 'board_credential',
    describe: (p) => `Connected your ${p.board} account.`,
  }),

  'board_credential.failed': define<{ board: string; error: string }>({
    subjectType: 'board_credential',
    describe: (p) =>
      `Could not sign in to ${p.board}: ${p.error}. Load search is paused ` +
      `until this is fixed.`,
    topic: 'board_credential.failed',
  }),
} as const;

export type EventVerb = keyof typeof eventCatalog;

/** The payload type for a given verb. */
export type PayloadOf<V extends EventVerb> =
  (typeof eventCatalog)[V] extends EventDefinition<infer P> ? P : never;
