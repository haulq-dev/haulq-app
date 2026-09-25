/**
 * Read a rate confirmation as a load, and store what came back as a proposal.
 * `FEATURE_REQUESTS_PLAN.md` section 12.
 *
 * The pipeline has already said what the document is (free, by rules) and read
 * the five fields the rules can read. This is the step after: an unattached rate
 * confirmation is worth asking a model what load it describes, so a person can
 * turn it into one by a tap instead of retyping it. Nothing here creates a load.
 * It stores a *proposal*, a reading with the text each part came from and a list
 * of what is missing, and a person decides.
 *
 * ---------------------------------------------------------------------------
 * When it does not run, on purpose
 * ---------------------------------------------------------------------------
 *
 * The model is a cost, and this mailbox takes mail from anyone. So it does not
 * run for:
 *
 *  - a document the rules did not call a rate confirmation. The rules are free
 *    and the title says so; a stranger's PDF that does not is never sent on.
 *  - a document already attached to a load: whatever it is, it has a home.
 *  - a document already proposed. One proposal per document, however many times
 *    the outbox redelivers. An earlier reading that came back empty is the one
 *    exception: asking again is how a person retries it.
 *  - a carrier that has already had its daily allowance of readings.
 *  - anywhere no model is configured, which is every environment without a key.
 *    Then nothing happens, as before this existed.
 *
 * A model that is briefly down is not an outcome here: `ModelReaderError` is
 * thrown, and the caller decides whether that is worth failing a delivery over.
 */

import { canCreateFromProposal, parseEquipment, proposalGaps, type ExtractedField, type LoadReading, type ProposedLoad } from '@haulq/contracts';
import {
  countLoadProposalsSince,
  findLoadByBrokerLoadNumber,
  getDocument,
  getLoadProposalByDocument,
  scope,
  storeLoadProposal,
  type LoadProposalRow,
  type Scope,
} from '@haulq/db';
import type { ModelDocumentReader } from './model-reader.ts';

export interface ProposeDeps {
  modelReader?: ModelDocumentReader | undefined;
  /** How many readings one carrier may have in a day. */
  dailyLimit: number;
}

export type ProposeOutcome =
  | { status: 'skipped'; why: 'not_found' | 'not_a_rate_confirmation' | 'attached' | 'no_reader' | 'daily_limit' }
  /** There already is one. Returned so a caller can show it. */
  | { status: 'exists'; proposal: LoadProposalRow }
  | { status: 'stored'; proposal: LoadProposalRow };

const DAY_MS = 86_400_000;

/**
 * Fold what the free rules read into the model's reading. A rule reads a label
 * and the model estimates, so where both have an answer the rule's wins: the
 * same order `pipeline.ts` applies to its own two readers.
 */
export function mergeRuleFields(reading: LoadReading, extracted: Record<string, ExtractedField> | null): LoadReading {
  if (!extracted) return reading;
  const load: ProposedLoad = { ...reading.load };
  const evidence = { ...reading.evidence };

  const rate = extracted['rateAmount'];
  if (rate && typeof rate.value === 'number' && rate.value > 0) {
    load.rateAmount = rate.value;
    evidence['rate'] = rate.raw;
  }
  const number = extracted['brokerLoadNumber'];
  if (number && typeof number.value === 'string' && number.value) {
    load.brokerLoadNumber = number.value;
    evidence['brokerLoadNumber'] = number.raw;
  }
  const weight = extracted['weightLbs'];
  if (weight && typeof weight.value === 'number' && weight.value > 0 && weight.value <= 80_000) {
    load.weightLbs = weight.value;
    evidence['weightLbs'] = weight.raw;
  }
  const equipment = extracted['equipment'];
  const parsed = equipment ? parseEquipment(equipment.raw) : null;
  if (equipment && parsed) {
    load.equipment = parsed;
    evidence['equipment'] = equipment.raw;
  }
  return { ...reading, load, evidence };
}

/**
 * Propose a load from a rate confirmation whose text has already been read.
 * `text` is the document's own text (the pipeline has it; the on-demand route
 * re-reads it from storage).
 */
export async function proposeLoad(
  s: Scope,
  documentId: string,
  text: string,
  deps: ProposeDeps,
  now: Date = new Date(),
): Promise<ProposeOutcome> {
  const document = await getDocument(s, documentId);
  if (!document) return { status: 'skipped', why: 'not_found' };
  if (document.kind !== 'rate_confirmation') return { status: 'skipped', why: 'not_a_rate_confirmation' };
  if (document.loadId) return { status: 'skipped', why: 'attached' };

  const existing = await getLoadProposalByDocument(s, documentId);
  if (existing && existing.status !== 'unreadable') return { status: 'exists', proposal: existing };

  const reader = deps.modelReader;
  if (!reader?.readLoad) return { status: 'skipped', why: 'no_reader' };

  if ((await countLoadProposalsSince(s, new Date(now.getTime() - DAY_MS))) >= deps.dailyLimit) {
    return { status: 'skipped', why: 'daily_limit' };
  }

  const reading = await reader.readLoad(text);
  // Attributed to the model that read it, not to whatever process asked: a
  // reading a model produced is the model's, the same rule the pipeline follows.
  const model = reader.loadReaderName ?? reader.name;
  const write = scope(s.db, { ...s.ctx, actor: { type: 'agent', model } });

  if (!reading) {
    const { proposal } = await storeLoadProposal(write, {
      documentId,
      status: 'unreadable',
      fields: { stops: [] },
      evidence: {},
      notes: ['This rate confirmation could not be read as a load. Create the load by hand.'],
      gaps: [],
      matchedLoadId: null,
      model,
    });
    return { status: 'stored', proposal };
  }

  const merged = mergeRuleFields(reading, document.extracted as Record<string, ExtractedField> | null);
  const matched = merged.load.brokerLoadNumber ? await findLoadByBrokerLoadNumber(s, merged.load.brokerLoadNumber) : undefined;

  const notes = [...merged.notes];
  if (matched) {
    notes.unshift(`Load ${matched.reference} already has this broker load number, so this may be its paperwork (or a reissue) and not a new load.`);
  }
  if (!canCreateFromProposal(merged.load)) {
    notes.push('There is no pickup and delivery to build a load from. Add them by hand, or create the load yourself.');
  }

  const { proposal } = await storeLoadProposal(write, {
    documentId,
    status: 'pending',
    fields: merged.load,
    evidence: merged.evidence,
    notes,
    gaps: proposalGaps(merged.load),
    matchedLoadId: matched?.id ?? null,
    model,
  });
  return { status: 'stored', proposal };
}
