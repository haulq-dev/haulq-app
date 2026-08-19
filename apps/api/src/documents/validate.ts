/**
 * Running validation against a document's load.
 *
 * The comparison itself is `validateAgainstLoad` in `@haulq/contracts`; this is
 * the part that has to know where a load lives and when the question is worth
 * asking. Two callers, because the two halves arrive in either order:
 *
 *  - the document pipeline, once a document has been read — but a rate
 *    confirmation often arrives by email before the load exists, so there is
 *    frequently nothing to compare against yet
 *  - the attach route, once a document is hung on a load — by which time it has
 *    usually already been read
 *
 * Whichever completes second is the one that produces a verdict. Neither knows
 * which it is, so both call this and it decides.
 */

import {
  validateAgainstLoad,
  type LoadFacts,
  type ValidationVerdict,
} from '@haulq/contracts';
import { getDocument, getLoad, recordValidation, type Scope } from '@haulq/db';

export type ValidationAttempt =
  /** Not ready. Named so a log line says which half is missing. */
  | { status: 'skipped'; why: 'not_found' | 'not_attached' | 'not_read' | 'load_missing' }
  | { status: 'validated'; verdict: ValidationVerdict; findingCount: number };

/**
 * Compare a document to its load, if both halves are there.
 *
 * Cheap — a read of two rows and a pure comparison — so it is safe to call
 * speculatively from anywhere either half might have just landed. It is *not*
 * safe to skip: a document that is never validated shows a carrier a green
 * status it did not earn.
 */
export async function validateDocument(
  s: Scope,
  documentId: string,
): Promise<ValidationAttempt> {
  const document = await getDocument(s, documentId);
  if (!document) return { status: 'skipped', why: 'not_found' };
  if (!document.loadId) return { status: 'skipped', why: 'not_attached' };

  // `extracted` null means nothing has read the page yet. Validating on that
  // would compare the load against silence and call the result agreement.
  if (document.extracted === null) return { status: 'skipped', why: 'not_read' };

  const load = await getLoad(s, document.loadId);
  if (!load) return { status: 'skipped', why: 'load_missing' };

  const facts: LoadFacts = {
    rateAmount: load.rateAmount,
    rateCurrency: load.rateCurrency,
    rateIsLinehaul: load.rateIsLinehaul,
    brokerLoadNumber: load.brokerLoadNumber,
    weightLbs: load.weightLbs,
    equipment: load.equipment,
  };

  const findings = validateAgainstLoad({
    kind: document.kind as never,
    extracted: document.extracted as Record<string, unknown>,
    load: facts,
  });

  const { verdict } = await recordValidation(s, documentId, findings);
  return { status: 'validated', verdict, findingCount: findings.length };
}
