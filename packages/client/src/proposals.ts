/**
 * Rate confirmations read as loads: what a review screen shows, and how what a
 * person leaves in the form becomes a load.
 * `FEATURE_REQUESTS_PLAN.md` section 12. The hooks that fetch these are in
 * `react.ts`.
 *
 * The form is the person's, not the reader's. It starts from what HaulQ read,
 * but every field is theirs to change, and the load is made from *the form*,
 * never from the proposal. Nothing about it is defaulted quietly: an equipment
 * type the reader could not find is asked for, because the default a load would
 * otherwise get (a straight box truck) is a wrong answer that looks right.
 */

import { parseMoney, type LoadProposalView, type ProposalGap, type ProposedEquipment, type ProposedStop } from '@haulq/contracts';

export type { LoadProposalStatus, LoadProposalView, ProposalGap, ProposedEquipment, ProposedLoad, ProposedStop } from '@haulq/contracts';

export const GAP_LABEL: Record<ProposalGap, string> = {
  pickup: 'a pickup',
  delivery: 'a delivery',
  rate: 'the rate',
  broker: 'the broker',
  brokerLoadNumber: 'the broker’s load number',
  equipment: 'the equipment',
};

export const EQUIPMENT_OPTIONS: ReadonlyArray<{ value: ProposedEquipment; label: string }> = [
  { value: 'DRY_VAN', label: 'Dry van' },
  { value: 'REEFER', label: 'Reefer' },
  { value: 'FLATBED', label: 'Flatbed' },
  { value: 'STRAIGHT_BOX', label: 'Straight truck / box truck' },
  { value: 'POWER_ONLY', label: 'Power only' },
  { value: 'OTHER', label: 'Other' },
];

export const equipmentLabel = (value: string | undefined): string | null => EQUIPMENT_OPTIONS.find((o) => o.value === value)?.label ?? null;

/** "$2,400.00" from integer cents. */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

// --- the form ------------------------------------------------------------------------

export interface StopForm {
  /** Identity for the list, so removing one does not shift another's fields. */
  key: string;
  type: 'pickup' | 'delivery';
  facilityName: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  /** As printed. Shown to the reviewer, never sent: it becomes a window or a note. */
  appointmentText: string;
  /** Carried through unchanged when the reader was certain of it; edited later on the load's stops. */
  windowStart: string;
  windowEnd: string;
}

export interface ProposalForm {
  brokerName: string;
  brokerLoadNumber: string;
  equipment: ProposedEquipment | '';
  /** What the person typed: "2,400.00". Parsed on the way out. */
  rate: string;
  weightLbs: string;
  commodity: string;
  comments: string;
  stops: StopForm[];
}

let nextKey = 1;
const stopKey = () => `stop-${nextKey++}`;

export function blankStop(type: 'pickup' | 'delivery'): StopForm {
  return {
    key: stopKey(),
    type,
    facilityName: '',
    addressLine1: '',
    city: '',
    state: '',
    postalCode: '',
    appointmentText: '',
    windowStart: '',
    windowEnd: '',
  };
}

function stopForm(stop: ProposedStop): StopForm {
  return {
    key: stopKey(),
    type: stop.type,
    facilityName: stop.facilityName ?? '',
    addressLine1: stop.addressLine1 ?? '',
    city: stop.city,
    state: stop.state,
    postalCode: stop.postalCode ?? '',
    appointmentText: stop.appointmentText ?? '',
    windowStart: stop.windowStart ?? '',
    windowEnd: stop.windowEnd ?? '',
  };
}

/**
 * The appointments the reader could not turn into a window, as a note for the
 * load's comments, so the person creating it does not lose what the rate
 * confirmation said. Empty when every appointment became a window.
 */
export function appointmentNotes(stops: readonly ProposedStop[]): string {
  const lines = stops
    .filter((s) => s.appointmentText && !s.windowStart)
    .map((s) => `- ${s.type === 'pickup' ? 'Pickup' : 'Delivery'}, ${s.city}, ${s.state}: ${s.appointmentText}`);
  return lines.length > 0 ? `Appointments as printed on the rate confirmation (not set as windows):\n${lines.join('\n')}` : '';
}

/** What the reader found, as a form a person can change. */
export function formFromProposal(view: Pick<LoadProposalView, 'load'>): ProposalForm {
  const load = view.load;
  return {
    brokerName: load.brokerName ?? '',
    brokerLoadNumber: load.brokerLoadNumber ?? '',
    equipment: load.equipment ?? '',
    rate: load.rateAmount !== undefined ? (load.rateAmount / 100).toFixed(2) : '',
    weightLbs: load.weightLbs !== undefined ? String(load.weightLbs) : '',
    commodity: load.commodity ?? '',
    comments: appointmentNotes(load.stops),
    stops: load.stops.map(stopForm),
  };
}

/**
 * What stops this form being a load. Blocking only: a missing rate or broker
 * is a warning on the screen, not a reason to refuse. Each is a sentence a
 * person can act on.
 */
export function formProblems(form: ProposalForm): string[] {
  const problems: string[] = [];
  if (!form.stops.some((s) => s.type === 'pickup')) problems.push('Add a pickup.');
  if (!form.stops.some((s) => s.type === 'delivery')) problems.push('Add a delivery.');
  form.stops.forEach((s, i) => {
    const which = `${s.type === 'pickup' ? 'Pickup' : 'Delivery'} ${i + 1}`;
    if (!s.city.trim()) problems.push(`${which} needs a city.`);
    if (!/^[A-Za-z]{2}$/.test(s.state.trim())) problems.push(`${which} needs a two-letter state.`);
  });
  if (!form.equipment) problems.push('Choose the equipment: it is not something HaulQ will guess.');
  if (form.rate.trim() && parseMoney(form.rate) === null) problems.push('The rate is not an amount, like 2,400.00.');
  if (form.weightLbs.trim()) {
    const w = Number(form.weightLbs.replace(/,/g, ''));
    if (!Number.isInteger(w) || w <= 0 || w > 80_000) problems.push('The weight is not a whole number of pounds a truck can carry.');
  }
  return problems;
}

const text = (v: string): string | undefined => (v.trim() ? v.trim() : undefined);

/**
 * The request that makes the load: `POST /v1/load-proposals/:id/create`. Blank
 * fields are left out rather than sent empty. The source and the status are the
 * server's to set.
 */
export function createBodyFromForm(form: ProposalForm, opts: { confirmDuplicate?: boolean } = {}): Record<string, unknown> {
  const rate = form.rate.trim() ? parseMoney(form.rate) : null;
  const weight = form.weightLbs.trim() ? Number(form.weightLbs.replace(/,/g, '')) : null;
  return {
    ...(text(form.brokerName) ? { brokerName: text(form.brokerName) } : {}),
    ...(text(form.brokerLoadNumber) ? { brokerLoadNumber: text(form.brokerLoadNumber) } : {}),
    equipment: form.equipment,
    ...(text(form.commodity) ? { commodity: text(form.commodity) } : {}),
    ...(text(form.comments) ? { comments: text(form.comments) } : {}),
    ...(weight !== null ? { weightLbs: weight } : {}),
    ...(rate !== null ? { rate: { amount: rate, currency: 'USD' } } : {}),
    stops: form.stops.map((s) => ({
      type: s.type,
      ...(text(s.facilityName) ? { facilityName: text(s.facilityName) } : {}),
      ...(text(s.addressLine1) ? { addressLine1: text(s.addressLine1) } : {}),
      city: s.city.trim(),
      state: s.state.trim().toUpperCase(),
      ...(text(s.postalCode) ? { postalCode: text(s.postalCode) } : {}),
      ...(s.windowStart ? { windowStart: s.windowStart } : {}),
      ...(s.windowEnd ? { windowEnd: s.windowEnd } : {}),
    })),
    ...(opts.confirmDuplicate ? { confirmDuplicate: true } : {}),
  };
}

// --- showing one -------------------------------------------------------------------

/** "Wichita, KS to Denver, CO", from the first pickup to the last delivery. Null when either end is missing. */
export function proposalLane(load: Pick<LoadProposalView['load'], 'stops'>): string | null {
  const first = load.stops.find((s) => s.type === 'pickup');
  const last = [...load.stops].reverse().find((s) => s.type === 'delivery');
  return first && last ? `${first.city}, ${first.state} to ${last.city}, ${last.state}` : null;
}

/** The evidence for a field: the exact text it was read from. Null when it was not read from anything. */
export function evidenceFor(view: Pick<LoadProposalView, 'evidence'>, path: string): string | null {
  return view.evidence[path] ?? null;
}

/** What is missing, in a sentence, or null when nothing is. */
export function gapSentence(gaps: readonly ProposalGap[]): string | null {
  if (gaps.length === 0) return null;
  const words = gaps.map((g) => GAP_LABEL[g]);
  const list = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `Could not find ${list}.`;
}
