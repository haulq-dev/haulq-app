/**
 * Load proposals: a rate confirmation read as the load it describes, and what a
 * person can do about it. `FEATURE_REQUESTS_PLAN.md` section 12.
 *
 * The routes are the guardrail. A proposal is only ever turned into a load by a
 * person, through `create` below; the pipeline that writes proposals has no way
 * to. `create` makes the load with source `broker_email`, hangs the rate
 * confirmation on it, and marks the proposal done, and it is built so that two
 * people acting at once, or one person double-tapping, cannot make two loads
 * (see `claimProposal`).
 *
 * Owner and dispatcher only: creating a load is dispatching.
 */

import {
  canCreateFromProposal,
  CreateLoadSchema,
  type LoadProposalView,
  type ProposalGap,
  type ProposedLoad,
} from '@haulq/contracts';
import {
  attachToLoad,
  claimProposal,
  completeProposal,
  createLoad,
  dismissProposal,
  findLoadByBrokerLoadNumber,
  getDocument,
  getLoad,
  getLoadProposal,
  listLoadProposals,
  markProposalAttached,
  releaseProposal,
  type LoadProposalListItem,
  type LoadProposalRow,
  type LoadProposalStatus,
  type Scope,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ModelReaderError } from '../documents/model-reader.ts';
import { proposeLoad } from '../documents/propose-load.ts';
import { validateDocument } from '../documents/validate.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';
import { rethrow as rethrowLoadError } from './loads.ts';

const IdParamSchema = z.object({ id: z.string().uuid() });
const StatusSchema = z.enum(['pending', 'created', 'attached', 'dismissed', 'unreadable']);
const ListQuerySchema = z.object({ status: StatusSchema.optional() });
const AttachBodySchema = z.object({ loadId: z.string().uuid() });

function view(
  row: LoadProposalRow,
  document: { filename: string | null; receivedAt: Date; receivedFrom: string | null },
  matchedLoadReference: number | null,
): LoadProposalView {
  const load = row.fields as ProposedLoad;
  return {
    id: row.id,
    documentId: row.documentId,
    status: row.status as LoadProposalStatus,
    filename: document.filename,
    receivedAt: document.receivedAt.toISOString(),
    receivedFrom: document.receivedFrom,
    load,
    evidence: row.evidence,
    notes: row.notes,
    gaps: row.gaps as ProposalGap[],
    canCreate: canCreateFromProposal(load),
    matchedLoad: row.matchedLoadId && matchedLoadReference !== null ? { id: row.matchedLoadId, reference: matchedLoadReference } : null,
    createdLoadId: row.createdLoadId,
    createdAt: row.createdAt.toISOString(),
  };
}

const viewItem = (item: LoadProposalListItem) => view(item, item, item.matchedLoadReference);

/** One proposal with its document and matched load, for a response that is not a list. */
async function viewOne(s: Scope, row: LoadProposalRow): Promise<LoadProposalView> {
  const document = await getDocument(s, row.documentId);
  const matched = row.matchedLoadId ? await getLoad(s, row.matchedLoadId) : undefined;
  return view(
    row,
    document ?? { filename: null, receivedAt: row.createdAt, receivedFrom: null },
    matched?.reference ?? null,
  );
}

function requirePerson(s: Scope, what: string): string {
  if (s.ctx.actor.type !== 'user') throw new HttpError(403, 'forbidden', `Only a person can ${what}.`);
  return s.ctx.actor.id;
}

export async function loadProposalRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/load-proposals',
    {
      schema: {
        tags: ['Load proposals'],
        summary: 'Rate confirmations read as loads, waiting for someone to look',
        querystring: ListQuerySchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const items = await listLoadProposals(s, { status: request.query.status ?? 'pending' });
      return { items: items.map(viewItem) };
    },
  );

  /**
   * One proposal, whatever state it is in. The email links straight to this, and
   * by the time someone follows it another person may already have created the
   * load: the screen needs to say so rather than show nothing.
   */
  server.get(
    '/v1/load-proposals/:id',
    { schema: { tags: ['Load proposals'], summary: 'One rate confirmation read as a load', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const row = await getLoadProposal(s, request.params.id);
      if (!row) throw new HttpError(404, 'not_found', 'That proposal is not in this account.');
      return viewOne(s, row);
    },
  );

  /**
   * Read a rate confirmation as a load now, when asked. The automatic path only
   * runs as a document arrives; this is for one that arrived before proposing
   * existed, or whose first reading came back empty.
   */
  server.post(
    '/v1/documents/:id/propose-load',
    { schema: { tags: ['Load proposals'], summary: 'Read this rate confirmation as a load', params: IdParamSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;

      const document = await getDocument(s, id);
      if (!document) throw new HttpError(404, 'not_found', 'That document is not in this account.');
      if (document.kind !== 'rate_confirmation') {
        throw new HttpError(409, 'not_a_rate_confirmation', 'Only a rate confirmation can be read as a load.');
      }
      if (document.loadId) {
        throw new HttpError(409, 'already_attached', 'That rate confirmation is already attached to a load.');
      }
      if (!app.modelReader?.readLoad) {
        throw new HttpError(
          503,
          'not_configured',
          'Reading a rate confirmation as a load is not set up on this deployment yet.',
        );
      }

      const bytes = await app.storage.get(document.storageKey);
      const read = await app.documentReader.read(bytes, document.contentType ?? 'application/octet-stream');
      if (!read.text) {
        throw new HttpError(422, 'unreadable_document', 'HaulQ could not get any text off that document to read.');
      }

      try {
        const outcome = await proposeLoad(s, id, read.text, {
          modelReader: app.modelReader,
          dailyLimit: app.env.LOAD_PROPOSALS_PER_DAY,
        });
        if (outcome.status === 'skipped') {
          if (outcome.why === 'daily_limit') {
            throw new HttpError(
              429,
              'daily_limit_reached',
              `This carrier has already had ${app.env.LOAD_PROPOSALS_PER_DAY} rate confirmations read as loads today. It starts over tomorrow; meanwhile the load can be created by hand.`,
            );
          }
          throw new HttpError(409, outcome.why, 'That rate confirmation cannot be read as a load right now.');
        }
        return reply.code(outcome.status === 'stored' ? 201 : 200).send(await viewOne(s, outcome.proposal));
      } catch (err) {
        if (err instanceof ModelReaderError) {
          throw new HttpError(502, 'model_unavailable', 'The reader is not available right now. Try again in a minute.');
        }
        throw err;
      }
    },
  );

  /**
   * Make the load. The body is the load as the reviewer left it in the form:
   * a `CreateLoad`, with the source forced to `broker_email` and the status
   * `booked` unless they chose otherwise (a rate confirmation means the broker
   * awarded it). `confirmDuplicate` lets a person create anyway when the broker
   * load number already belongs to another load.
   */
  server.post(
    '/v1/load-proposals/:id/create',
    {
      schema: {
        tags: ['Load proposals'],
        summary: 'Create the load from this proposal',
        params: IdParamSchema,
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const userId = requirePerson(s, 'create a load from a rate confirmation');
      const { id } = request.params;

      const { confirmDuplicate, ...rest } = request.body;
      const parsed = CreateLoadSchema.safeParse({ status: 'booked', ...rest, source: 'broker_email' });
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_load',
          parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
        );
      }
      const input = parsed.data;

      const proposal = await getLoadProposal(s, id);
      if (!proposal) throw new HttpError(404, 'not_found', 'That proposal no longer exists.');
      if (proposal.status !== 'pending') {
        throw new HttpError(409, 'already_handled', 'Someone has already dealt with that rate confirmation.');
      }
      const document = await getDocument(s, proposal.documentId);
      if (!document) throw new HttpError(404, 'not_found', 'That rate confirmation no longer exists.');
      if (document.loadId) {
        throw new HttpError(409, 'already_attached', 'That rate confirmation is already attached to a load.');
      }

      if (input.brokerLoadNumber && confirmDuplicate !== true) {
        const duplicate = await findLoadByBrokerLoadNumber(s, input.brokerLoadNumber);
        if (duplicate) {
          throw new HttpError(
            409,
            'duplicate_load_number',
            `Load ${duplicate.reference} already has the broker load number ${input.brokerLoadNumber}. Attach this rate confirmation to it instead, or create a new load anyway.`,
          );
        }
      }

      // The lock: whoever's update moves the proposal out of `pending` goes on.
      const claimed = await claimProposal(s, id, userId);
      if (!claimed) throw new HttpError(409, 'already_handled', 'Someone has already dealt with that rate confirmation.');

      let created: { id: string; reference: number } | undefined;
      try {
        const load = await createLoad(s, input);
        created = { id: load.id, reference: load.reference };
        await attachToLoad(s, document.id, load.id);
        // The rate confirmation and its load are now both there, so this is the
        // moment to check one against the other, exactly as attaching by hand does.
        await validateDocument(s, document.id);
        await completeProposal(s, id, created);
      } catch (err) {
        if (created) {
          // The load exists. Leaving the proposal claimable would let a second
          // load be made from the same document, so it is closed against this one.
          await completeProposal(s, id, created).catch(() => undefined);
          throw new HttpError(
            500,
            'partially_created',
            `Load ${created.reference} was created, but attaching the rate confirmation to it failed. Attach it by hand from the load.`,
          );
        }
        // Nothing was made, so the proposal goes back for another try.
        await releaseProposal(s, id).catch(() => undefined);
        rethrowLoadError(err);
      }

      const fresh = await getLoadProposal(s, id);
      return reply.code(201).send({
        load: created,
        proposal: fresh ? await viewOne(s, fresh) : null,
      });
    },
  );

  server.post(
    '/v1/load-proposals/:id/attach',
    {
      schema: {
        tags: ['Load proposals'],
        summary: 'Attach this rate confirmation to an existing load instead',
        params: IdParamSchema,
        body: AttachBodySchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const userId = requirePerson(s, 'attach a rate confirmation');
      const { id } = request.params;

      const proposal = await getLoadProposal(s, id);
      if (!proposal) throw new HttpError(404, 'not_found', 'That proposal no longer exists.');
      if (proposal.status !== 'pending') {
        throw new HttpError(409, 'already_handled', 'Someone has already dealt with that rate confirmation.');
      }
      const load = await getLoad(s, request.body.loadId);
      if (!load) throw new HttpError(404, 'not_found', 'That load is not in this account.');

      await attachToLoad(s, proposal.documentId, load.id);
      const validation = await validateDocument(s, proposal.documentId);
      const done = await markProposalAttached(s, id, userId, { id: load.id, reference: load.reference });
      if (!done) throw new HttpError(409, 'already_handled', 'Someone has already dealt with that rate confirmation.');

      return {
        load: { id: load.id, reference: load.reference },
        validation:
          validation.status === 'validated' ? { outcome: validation.verdict.outcome, reason: validation.verdict.reason } : null,
      };
    },
  );

  server.post(
    '/v1/load-proposals/:id/dismiss',
    { schema: { tags: ['Load proposals'], summary: 'This is not a load to create', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const userId = requirePerson(s, 'dismiss a proposal');
      const done = await dismissProposal(s, request.params.id, userId);
      if (done) return { ok: true };
      const existing = await getLoadProposal(s, request.params.id);
      if (!existing) throw new HttpError(404, 'not_found', 'That proposal no longer exists.');
      throw new HttpError(409, 'already_handled', 'Someone has already dealt with that rate confirmation.');
    },
  );
}
