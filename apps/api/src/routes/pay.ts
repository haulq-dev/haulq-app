/**
 * HaulQ Pay — invoices, factoring, payments.
 *
 * Same shape as `loads.ts`: validate, call a repository, return — with the
 * same addition that file earns its place on. `sql/post/0700_invoice_status.sql`
 * owns the invoice state machine and `0500_constraints.sql` owns the
 * open-ended columns, so a refusal can arrive as a raw Postgres error naming
 * a constraint. `rethrow` is where that becomes a sentence a carrier reads,
 * same split of responsibility as `loads.ts` describes in its own header.
 */

import {
  AssembleFactoringPacketSchema,
  CreateFactoringCompanySchema,
  FactoringResponseSchema,
  GenerateInvoiceSchema,
  RecordPaymentSchema,
  VoidInvoiceSchema,
} from '@haulq/contracts';
import {
  assembleFactoringPacket,
  createFactoringCompany,
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

function badRequest(issues: { path: (string | number)[]; message: string }[]): never {
  throw new HttpError(
    400,
    'invalid_request',
    issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
  );
}

export async function payRoutes(app: FastifyInstance) {
  // --- invoices --------------------------------------------------------------

  app.get('/v1/invoices', async (request) => {
    const s = await requireScope(request);
    const q = request.query as { status?: string; loadId?: string; limit?: string };

    const status = q.status
      ? (q.status.split(',').map((x) => x.trim()).filter(Boolean) as InvoiceStatus[])
      : undefined;

    const items = await listInvoices(s, {
      ...(status?.length ? { status } : {}),
      ...(q.loadId ? { loadId: q.loadId } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });

    return { items, counts: await invoiceCounts(s) };
  });

  /** Registered before `/:id` so the router does not read "receivables-aging" as an id. */
  app.get('/v1/invoices/receivables-aging', async (request) => {
    const s = await requireScope(request);
    return { buckets: await receivablesAging(s) };
  });

  app.get('/v1/invoices/:id', async (request) => {
    const s = await requireScope(request);
    const { id } = request.params as { id: string };
    const invoice = await getInvoice(s, id);
    if (!invoice) throw new HttpError(404, 'not_found', 'That invoice is not in this account.');
    return { invoice };
  });

  app.get('/v1/invoices/:id/payments', async (request) => {
    const s = await requireScope(request);
    const { id } = request.params as { id: string };
    return { items: await listPayments(s, id) };
  });

  app.post('/v1/invoices', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher', 'accountant');

    const parsed = GenerateInvoiceSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return reply.code(201).send(await generateInvoice(s, parsed.data));
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/invoices/:id/send', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher', 'accountant');
    const { id } = request.params as { id: string };

    try {
      return await sendInvoice(s, id);
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/invoices/:id/void', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'accountant');
    const { id } = request.params as { id: string };

    const parsed = VoidInvoiceSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await voidInvoice(s, id, parsed.data.reason);
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/invoices/:id/payments', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'accountant');
    const { id } = request.params as { id: string };

    const parsed = RecordPaymentSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      const result = await recordPayment(s, {
        invoiceId: id,
        amountCents: parsed.data.amount.amount,
        currency: parsed.data.amount.currency,
        source: parsed.data.source,
        ...(parsed.data.receivedAt ? { receivedAt: parsed.data.receivedAt } : {}),
        ...(parsed.data.reference ? { reference: parsed.data.reference } : {}),
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.factoringPacketId
          ? { factoringPacketId: parsed.data.factoringPacketId }
          : {}),
      });
      return reply.code(201).send(result);
    } catch (err) {
      rethrow(err);
    }
  });

  // --- factoring companies -----------------------------------------------------

  app.get('/v1/factoring-companies', async (request) => {
    const s = await requireScope(request);
    return { items: await listFactoringCompanies(s) };
  });

  app.post('/v1/factoring-companies', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'accountant');

    const parsed = CreateFactoringCompanySchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return reply.code(201).send(await createFactoringCompany(s, parsed.data));
    } catch (err) {
      rethrow(err);
    }
  });

  // --- factoring packets ----------------------------------------------------

  app.get('/v1/factoring-packets', async (request) => {
    const s = await requireScope(request);
    const q = request.query as { invoiceId?: string; status?: string };

    const status = q.status
      ? (q.status.split(',').map((x) => x.trim()).filter(Boolean) as FactoringPacketStatus[])
      : undefined;

    return {
      items: await listFactoringPackets(s, {
        ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
        ...(status?.length ? { status } : {}),
      }),
    };
  });

  app.get('/v1/factoring-packets/:id', async (request) => {
    const s = await requireScope(request);
    const { id } = request.params as { id: string };
    const packet = await getFactoringPacket(s, id);
    if (!packet) throw new HttpError(404, 'not_found', 'That factoring packet is not in this account.');
    return { packet };
  });

  app.post('/v1/factoring-packets', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher', 'accountant');

    const parsed = AssembleFactoringPacketSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return reply.code(201).send(await assembleFactoringPacket(s, parsed.data));
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/factoring-packets/:id/submit', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher', 'accountant');
    const { id } = request.params as { id: string };

    try {
      return await submitFactoringPacket(s, id);
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/factoring-packets/:id/response', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'accountant');
    const { id } = request.params as { id: string };

    const parsed = FactoringResponseSchema.safeParse(request.body);
    if (!parsed.success) badRequest(parsed.error.issues);

    try {
      return await recordFactoringResponse(s, id, parsed.data);
    } catch (err) {
      rethrow(err);
    }
  });
}
