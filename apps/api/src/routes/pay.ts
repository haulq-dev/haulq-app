/**
 * HaulQ Pay — invoices, factoring, payments.
 *
 * Same shape as `loads.ts`: validate, call a repository, return — with the
 * same addition that file earns its place on. `sql/post/0700_invoice_status.sql`
 * owns the invoice state machine and `0500_constraints.sql` owns the
 * open-ended columns, so a refusal can arrive as a raw Postgres error naming
 * a constraint. `rethrow` is where that becomes a sentence a carrier reads,
 * same split of responsibility as `loads.ts` describes in its own header.
 *
 * Validation happens through Fastify's own `schema` option, same as
 * `trucks.ts`/`loads.ts` — see that file's module note for why. The
 * Postgres-refusal translation below is unrelated to that and unaffected by
 * it: it only ever runs after a request has already passed schema validation.
 */

import {
  AssembleFactoringPacketSchema,
  CreateFactoringCompanySchema,
  FactoringResponseSchema,
  GenerateInvoiceSchema,
  PageQuerySchema,
  RecordPaymentSchema,
  VoidInvoiceSchema,
} from '@haulq/contracts';
import {
  assembleFactoringPacket,
  createFactoringCompany,
  CursorError,
  generateInvoice,
  getFactoringPacket,
  getInvoice,
  invoiceCounts,
  listFactoringCompanies,
  listFactoringPackets,
  listInvoices,
  listPayments,
  PayError,
  receivablesAging,
  recordFactoringResponse,
  recordPayment,
  sendInvoice,
  submitFactoringPacket,
  voidInvoice,
  type FactoringPacketStatus,
  type InvoiceStatus,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

/** Postgres SQLSTATEs this route knows how to explain. Same as `loads.ts`. */
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
/** What `0700_invoice_status.sql` raises with `using errcode = 'restrict_violation'`. */
const RESTRICT_VIOLATION = '23001';

const CHECK_EXPLANATION: Record<string, string> = {
  invoices_total_positive: 'An invoice needs a positive total.',
  payments_amount_positive: 'A payment amount must be positive.',
  factoring_companies_submission_method_ck:
    'That is not a submission method HaulQ supports.',
  invoices_sent_has_timestamp:
    'A sent invoice needs the date it was sent. This is a bug — please report it.',
  invoices_paid_has_timestamp:
    'A paid invoice needs the date it was paid. This is a bug — please report it.',
  invoices_void_has_timestamp_and_reason:
    'A voided invoice needs the date and reason it was voided. This is a bug — please report it.',
};

const UNIQUE_EXPLANATION: Record<string, string> = {
  invoices_load_key: 'That load already has an invoice. Void it before generating another.',
  invoices_org_reference_key: 'That invoice number is already in use.',
  factoring_companies_org_name_key: 'A factoring company with that name already exists.',
};

/** Codes `PayError` raises that mean "the thing named doesn't exist here". */
const NOT_FOUND_CODES = new Set(['not_found', 'load_not_found', 'factoring_company_not_found']);
/** Codes that mean "the request is malformed", as opposed to a state conflict. */
const BAD_REQUEST_CODES = new Set(['no_line_items', 'mixed_currency', 'reason_required']);

interface PgError {
  code?: string;
  constraint_name?: string;
  message?: string;
}

function rethrow(err: unknown): never {
  if (err instanceof PayError) {
    const status = NOT_FOUND_CODES.has(err.code)
      ? 404
      : BAD_REQUEST_CODES.has(err.code)
        ? 400
        : 409;
    throw new HttpError(status, err.code, err.explanation);
  }

  if (err instanceof CursorError) {
    throw new HttpError(400, err.code, err.explanation);
  }

  const pg = err as PgError;

  if (pg.code === RESTRICT_VIOLATION) {
    // The trigger writes these for people, not for logs — see loads.ts's note.
    throw new HttpError(
      409,
      'illegal_transition',
      pg.message ?? 'That change is not allowed for this invoice.',
    );
  }

  if (pg.code === CHECK_VIOLATION) {
    const explanation =
      CHECK_EXPLANATION[pg.constraint_name ?? ''] ??
      'That change would leave this in a state HaulQ does not allow.';
    throw new HttpError(422, pg.constraint_name ?? 'check_violation', explanation);
  }

  if (pg.code === UNIQUE_VIOLATION) {
    const explanation = UNIQUE_EXPLANATION[pg.constraint_name ?? ''] ?? 'That already exists.';
    throw new HttpError(409, pg.constraint_name ?? 'duplicate', explanation);
  }

  throw err;
}

const IdParamSchema = z.object({ id: z.string().uuid() });

const InvoicesQuerySchema = PageQuerySchema.extend({
  status: z.string().optional(),
  loadId: z.string().uuid().optional(),
});

const FactoringPacketsQuerySchema = PageQuerySchema.extend({
  invoiceId: z.string().uuid().optional(),
  status: z.string().optional(),
});

export async function payRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // --- invoices --------------------------------------------------------------

  server.get(
    '/v1/invoices',
    { schema: { tags: ['Pay'], summary: 'List invoices', querystring: InvoicesQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const { status: statusParam, loadId, cursor, limit } = request.query;

      const status = statusParam
        ? (statusParam.split(',').map((x) => x.trim()).filter(Boolean) as InvoiceStatus[])
        : undefined;

      try {
        const { items, nextCursor } = await listInvoices(s, {
          ...(status?.length ? { status } : {}),
          ...(loadId ? { loadId } : {}),
          limit,
          ...(cursor ? { cursor } : {}),
        });

        return { items, nextCursor, counts: await invoiceCounts(s) };
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /** Registered before `/:id` so the router does not read "receivables-aging" as an id. */
  server.get(
    '/v1/invoices/receivables-aging',
    { schema: { tags: ['Pay'], summary: 'Receivables aging buckets' } },
    async (request) => {
      const s = await requireScope(request);
      return { buckets: await receivablesAging(s) };
    },
  );

  server.get(
    '/v1/invoices/:id',
    { schema: { tags: ['Pay'], summary: 'Get an invoice', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      const { id } = request.params;
      const invoice = await getInvoice(s, id);
      if (!invoice) throw new HttpError(404, 'not_found', 'That invoice is not in this account.');
      return { invoice };
    },
  );

  server.get(
    '/v1/invoices/:id/payments',
    { schema: { tags: ['Pay'], summary: "An invoice's payments", params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      const { id } = request.params;
      return { items: await listPayments(s, id) };
    },
  );

  server.post(
    '/v1/invoices',
    { schema: { tags: ['Pay'], summary: 'Generate an invoice for a delivered load', body: GenerateInvoiceSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher', 'accountant');

      try {
        return reply.code(201).send(await generateInvoice(s, request.body));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/invoices/:id/send',
    { schema: { tags: ['Pay'], summary: 'Send an invoice', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher', 'accountant');
      const { id } = request.params;

      try {
        return await sendInvoice(s, id);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/invoices/:id/void',
    {
      schema: {
        tags: ['Pay'],
        summary: 'Void an invoice',
        params: IdParamSchema,
        body: VoidInvoiceSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'accountant');
      const { id } = request.params;

      try {
        return await voidInvoice(s, id, request.body.reason);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/invoices/:id/payments',
    {
      schema: {
        tags: ['Pay'],
        summary: 'Record a payment against an invoice',
        params: IdParamSchema,
        body: RecordPaymentSchema,
      },
    },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'accountant');
      const { id } = request.params;
      const body = request.body;

      try {
        const result = await recordPayment(s, {
          invoiceId: id,
          amountCents: body.amount.amount,
          currency: body.amount.currency,
          source: body.source,
          ...(body.receivedAt ? { receivedAt: body.receivedAt } : {}),
          ...(body.reference ? { reference: body.reference } : {}),
          ...(body.notes ? { notes: body.notes } : {}),
          ...(body.factoringPacketId ? { factoringPacketId: body.factoringPacketId } : {}),
        });
        return reply.code(201).send(result);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // --- factoring companies -----------------------------------------------------

  server.get(
    '/v1/factoring-companies',
    { schema: { tags: ['Pay'], summary: 'List factoring companies', querystring: PageQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const { cursor, limit } = request.query;
      try {
        return await listFactoringCompanies(s, { ...(cursor ? { cursor } : {}), limit });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/factoring-companies',
    { schema: { tags: ['Pay'], summary: 'Add a factoring company', body: CreateFactoringCompanySchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'accountant');

      try {
        return reply.code(201).send(await createFactoringCompany(s, request.body));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // --- factoring packets ----------------------------------------------------

  server.get(
    '/v1/factoring-packets',
    { schema: { tags: ['Pay'], summary: 'List factoring packets', querystring: FactoringPacketsQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const { invoiceId, status: statusParam, cursor, limit } = request.query;

      const status = statusParam
        ? (statusParam.split(',').map((x) => x.trim()).filter(Boolean) as FactoringPacketStatus[])
        : undefined;

      try {
        return await listFactoringPackets(s, {
          ...(invoiceId ? { invoiceId } : {}),
          ...(status?.length ? { status } : {}),
          ...(cursor ? { cursor } : {}),
          limit,
        });
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.get(
    '/v1/factoring-packets/:id',
    { schema: { tags: ['Pay'], summary: 'Get a factoring packet', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      const { id } = request.params;
      const packet = await getFactoringPacket(s, id);
      if (!packet) throw new HttpError(404, 'not_found', 'That factoring packet is not in this account.');
      return { packet };
    },
  );

  server.post(
    '/v1/factoring-packets',
    { schema: { tags: ['Pay'], summary: 'Assemble a factoring packet', body: AssembleFactoringPacketSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher', 'accountant');

      try {
        return reply.code(201).send(await assembleFactoringPacket(s, request.body));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/factoring-packets/:id/submit',
    { schema: { tags: ['Pay'], summary: 'Mark a factoring packet submitted', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher', 'accountant');
      const { id } = request.params;

      try {
        return await submitFactoringPacket(s, id);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/factoring-packets/:id/response',
    {
      schema: {
        tags: ['Pay'],
        summary: "Record a factor's response to a packet",
        params: IdParamSchema,
        body: FactoringResponseSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'accountant');
      const { id } = request.params;

      try {
        return await recordFactoringResponse(s, id, request.body);
      } catch (err) {
        rethrow(err);
      }
    },
  );
}
