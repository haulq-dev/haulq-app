/**
 * Load proposals: storing a reading, listing what is waiting, and the three
 * things a person can do with one. `FEATURE_REQUESTS_PLAN.md` section 12.
 *
 * Every state change is conditional on the proposal still being `pending`, so
 * two people acting on the same one, or one person double-tapping, cannot make
 * two loads: the second finds nothing to change and is told so.
 */

import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { documents } from '../schema/documents.ts';
import { loadProposals } from '../schema/load-proposals.ts';
import { loads } from '../schema/loads.ts';
import { withTransaction } from '../transaction.ts';

export type LoadProposalRow = typeof loadProposals.$inferSelect;

export type LoadProposalStatus = 'pending' | 'created' | 'attached' | 'dismissed' | 'unreadable';

export interface StoreLoadProposalInput {
  documentId: string;
  /** 'pending', or 'unreadable' for a reading that produced nothing. */
  status: 'pending' | 'unreadable';
  fields: unknown;
  evidence: Record<string, string>;
  notes: string[];
  gaps: string[];
  matchedLoadId: string | null;
  model: string | null;
}

/**
 * Store a reading against its document.
 *
 * One proposal per document. If there already is one, it is returned untouched
 * (`created: false`), except an `unreadable` one, which a new reading replaces:
 * asking again is exactly how someone retries a reading that came back empty.
 */
export async function storeLoadProposal(
  s: Scope,
  input: StoreLoadProposalInput,
): Promise<{ proposal: LoadProposalRow; created: boolean }> {
  return withTransaction(s, async (tx) => {
    const [existing] = await tx.db
      .select()
      .from(loadProposals)
      .where(and(eq(loadProposals.orgId, tx.ctx.orgId), eq(loadProposals.documentId, input.documentId)));

    if (existing && existing.status !== 'unreadable') return { proposal: existing, created: false };

    const values = {
      status: input.status,
      fields: input.fields,
      evidence: input.evidence,
      notes: input.notes,
      gaps: input.gaps,
      matchedLoadId: input.matchedLoadId,
      model: input.model,
    };

    const [row] = existing
      ? await tx.db
          .update(loadProposals)
          // A new reading is a new model call, so it counts as one today: without
          // this a retry of an unreadable proposal would slip past the daily cap.
          .set({ ...values, createdAt: new Date(), updatedAt: new Date() })
          .where(and(eq(loadProposals.id, existing.id), eq(loadProposals.orgId, tx.ctx.orgId)))
          .returning()
      : await tx.db
          .insert(loadProposals)
          .values({ orgId: tx.ctx.orgId, documentId: input.documentId, ...values })
          .returning();
    if (!row) throw new Error('load proposal write returned nothing');

    // Nothing is worth an event for a reading that produced nothing.
    if (input.status === 'pending') {
      const [doc] = await tx.db
        .select({ filename: documents.filename })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.orgId, tx.ctx.orgId)));
      const stops = Array.isArray((input.fields as { stops?: unknown[] } | null)?.stops)
        ? (input.fields as { stops: unknown[] }).stops.length
        : 0;
      await recordEvent(tx, 'load_proposal.created', {
        subjectId: row.id,
        payload: { filename: doc?.filename ?? 'a rate confirmation', stops, proposalId: row.id },
      });
    }
    return { proposal: row, created: true };
  });
}

/** A proposal with just enough of its document to show a list. */
export interface LoadProposalListItem extends LoadProposalRow {
  filename: string | null;
  receivedAt: Date;
  receivedFrom: string | null;
  matchedLoadReference: number | null;
}

export async function listLoadProposals(
  s: Scope,
  opts: { status?: LoadProposalStatus | undefined; limit?: number | undefined } = {},
): Promise<LoadProposalListItem[]> {
  const rows = await s.db
    .select({
      proposal: loadProposals,
      filename: documents.filename,
      receivedAt: documents.receivedAt,
      receivedFrom: documents.receivedFrom,
      matchedLoadReference: loads.reference,
    })
    .from(loadProposals)
    .innerJoin(documents, eq(documents.id, loadProposals.documentId))
    .leftJoin(loads, eq(loads.id, loadProposals.matchedLoadId))
    .where(
      and(
        eq(loadProposals.orgId, s.ctx.orgId),
        isNull(loadProposals.deletedAt),
        opts.status ? eq(loadProposals.status, opts.status) : undefined,
      ),
    )
    .orderBy(desc(loadProposals.createdAt))
    .limit(opts.limit ?? 100);

  return rows.map((r) => ({
    ...r.proposal,
    filename: r.filename,
    receivedAt: r.receivedAt,
    receivedFrom: r.receivedFrom,
    matchedLoadReference: r.matchedLoadReference ?? null,
  }));
}

export async function getLoadProposal(s: Scope, id: string): Promise<LoadProposalRow | undefined> {
  const [row] = await s.db
    .select()
    .from(loadProposals)
    .where(and(eq(loadProposals.id, id), eq(loadProposals.orgId, s.ctx.orgId), isNull(loadProposals.deletedAt)));
  return row;
}

export async function getLoadProposalByDocument(s: Scope, documentId: string): Promise<LoadProposalRow | undefined> {
  const [row] = await s.db
    .select()
    .from(loadProposals)
    .where(and(eq(loadProposals.documentId, documentId), eq(loadProposals.orgId, s.ctx.orgId)));
  return row;
}

/** How many readings this organisation has had since a moment. Each one cost a model call, so this is what the daily cap counts. */
export async function countLoadProposalsSince(s: Scope, since: Date): Promise<number> {
  const [row] = await s.db
    .select({ n: count() })
    .from(loadProposals)
    .where(and(eq(loadProposals.orgId, s.ctx.orgId), gte(loadProposals.createdAt, since)));
  return row?.n ?? 0;
}

/**
 * The load this broker load number already belongs to, if any. A rate
 * confirmation carrying the number of an existing load is that load's paperwork
 * (often a reissue), not a second load. Most recent first, cancelled included:
 * a cancelled load's number being reused is exactly what a person should be told.
 */
export async function findLoadByBrokerLoadNumber(
  s: Scope,
  brokerLoadNumber: string,
): Promise<{ id: string; reference: number } | undefined> {
  const [row] = await s.db
    .select({ id: loads.id, reference: loads.reference })
    .from(loads)
    .where(
      and(
        eq(loads.orgId, s.ctx.orgId),
        isNull(loads.deletedAt),
        // Compared without case or edge whitespace: "pf-40417 " is the same number.
        sql`lower(btrim(${loads.brokerLoadNumber})) = lower(btrim(${brokerLoadNumber}))`,
      ),
    )
    .orderBy(desc(loads.createdAt))
    .limit(1);
  return row;
}

async function decide(
  s: Scope,
  id: string,
  userId: string,
  status: 'attached' | 'dismissed',
  extra: { matchedLoadId?: string },
  event: (filename: string) => { verb: 'load_proposal.accepted' | 'load_proposal.attached' | 'load_proposal.dismissed'; payload: Record<string, unknown> },
): Promise<LoadProposalRow | undefined> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(loadProposals)
      .set({
        status,
        decidedByUserId: userId,
        decidedAt: new Date(),
        updatedAt: new Date(),
        ...(extra.matchedLoadId ? { matchedLoadId: extra.matchedLoadId } : {}),
      })
      .where(and(eq(loadProposals.id, id), eq(loadProposals.orgId, tx.ctx.orgId), eq(loadProposals.status, 'pending')))
      .returning();
    if (!row) return undefined;

    const [doc] = await tx.db
      .select({ filename: documents.filename })
      .from(documents)
      .where(and(eq(documents.id, row.documentId), eq(documents.orgId, tx.ctx.orgId)));
    const { verb, payload } = event(doc?.filename ?? 'a rate confirmation');
    await recordEvent(tx, verb as 'load_proposal.accepted', { subjectId: row.id, payload: payload as { filename: string; reference: number } });
    return row;
  });
}

/**
 * Creating a load from a proposal is three steps (claim it, make the load, record
 * the result), and two people acting at once must not make two loads. So the
 * first step is the lock: claiming moves the proposal out of `pending` in one
 * conditional update, and only the caller whose update changed a row goes on. The
 * other is told it is already taken. If making the load then fails, `release`
 * puts the proposal back so nothing is lost.
 */
export async function claimProposal(s: Scope, id: string, userId: string): Promise<LoadProposalRow | undefined> {
  const [row] = await s.db
    .update(loadProposals)
    .set({ status: 'created', decidedByUserId: userId, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(loadProposals.id, id), eq(loadProposals.orgId, s.ctx.orgId), eq(loadProposals.status, 'pending')))
    .returning();
  return row;
}

/** The load exists: record which one, and that it was accepted. */
export async function completeProposal(s: Scope, id: string, load: { id: string; reference: number }): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(loadProposals)
      .set({ createdLoadId: load.id, updatedAt: new Date() })
      .where(and(eq(loadProposals.id, id), eq(loadProposals.orgId, tx.ctx.orgId), eq(loadProposals.status, 'created')))
      .returning();
    if (!row) return;
    const [doc] = await tx.db
      .select({ filename: documents.filename })
      .from(documents)
      .where(and(eq(documents.id, row.documentId), eq(documents.orgId, tx.ctx.orgId)));
    await recordEvent(tx, 'load_proposal.accepted', {
      subjectId: row.id,
      payload: { filename: doc?.filename ?? 'a rate confirmation', reference: load.reference },
    });
  });
}

/** Making the load failed after the claim: put the proposal back for someone to try again. */
export async function releaseProposal(s: Scope, id: string): Promise<void> {
  await s.db
    .update(loadProposals)
    .set({ status: 'pending', decidedByUserId: null, decidedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(loadProposals.id, id),
        eq(loadProposals.orgId, s.ctx.orgId),
        eq(loadProposals.status, 'created'),
        isNull(loadProposals.createdLoadId),
      ),
    );
}

/** A person attached the document to an existing load instead. */
export function markProposalAttached(s: Scope, id: string, userId: string, load: { id: string; reference: number }) {
  return decide(s, id, userId, 'attached', { matchedLoadId: load.id }, (filename) => ({
    verb: 'load_proposal.attached',
    payload: { filename, reference: load.reference },
  }));
}

/** A person said this is not a load to create. */
export function dismissProposal(s: Scope, id: string, userId: string) {
  return decide(s, id, userId, 'dismissed', {}, (filename) => ({ verb: 'load_proposal.dismissed', payload: { filename } }));
}
