/**
 * CSV import.
 *
 * The file arrives as a raw body with `content-type: text/csv` rather than as
 * multipart. A browser can post a `File` object directly as a fetch body, so
 * multipart buys nothing here except a dependency and a parser — and this
 * endpoint takes exactly one file, never a mixed form.
 *
 * The upload route's body stays outside Fastify's schema option, same
 * reasoning as `documents.ts`: it is raw bytes, not JSON. Every other route
 * here validates natively — see `trucks.ts`'s module note for why.
 */

import { ColumnMappingSchema, guessMapping, PageQuerySchema } from '@haulq/contracts';
import {
  applyMapping,
  commitImport,
  CursorError,
  getBatch,
  ImportError,
  importedHistorySummary,
  key as storageKey,
  listBatches,
  listRows,
  markOperatingFactsReconciled,
  sha256,
  startImport,
} from '@haulq/db';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

/** 20 MB. A 90-day export from a small carrier is under 1 MB; this is slack. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const IdParamSchema = z.object({ id: z.string().uuid() });
const UploadQuerySchema = z.object({ filename: z.string().optional() });
/**
 * `onlyInvalid` stays a plain string, checked against `'true'` below exactly
 * as it always was — see `documents.ts`'s note on `unattached` for why not
 * `z.coerce.boolean()`.
 */
const BatchRowsQuerySchema = z.object({
  onlyInvalid: z.string().optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

export async function importRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Raw body, kept as a Buffer so the sha256 is over the bytes as uploaded
  // rather than over a re-encoded string.
  app.addContentTypeParser(
    ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  /**
   * Upload a file.
   *
   * Without a `mapping` query parameter the batch stops at `mapping` and the
   * response carries the guessed mapping plus five sample rows. Guessing from
   * column names alone is how "Rate" gets mapped to linehaul when it is all-in,
   * so the operator sees real values beside each header before confirming.
   */
  server.post(
    '/v1/imports',
    { schema: { tags: ['Imports'], summary: 'Upload a CSV of past loads', querystring: UploadQuerySchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher', 'accountant');

      const body = request.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new HttpError(
          400,
          'invalid_request',
          'Send the CSV file as the request body with content-type: text/csv.',
        );
      }

      const filename = (request.query.filename ?? 'import.csv').replace(/[^\w.\-]/g, '_').slice(0, 120);

      // UTF-8 with a lenient decoder. A carrier's export is occasionally
      // Windows-1252; a stray byte should mangle one cell, not reject the file.
      const text = body.toString('utf8');

      const batchId = randomUUID();
      const key = storageKey({
        orgId: s.ctx.orgId,
        kind: 'imports',
        id: batchId,
        filename,
      });
      await app.storage.put(key, body, 'text/csv');

      try {
        const result = await startImport(s, {
          filename,
          storageKey: key,
          sha256: sha256(body),
          text,
        });

        return reply.code(201).send({
          batch: result.batch,
          headers: result.headers,
          suggestedMapping: guessMapping(result.headers),
          sampleRows: result.sampleRows,
        });
      } catch (err) {
        if (err instanceof ImportError) {
          // The stored object is left in place. It costs almost nothing and it is
          // the only evidence of what the carrier actually sent when they report
          // that HaulQ could not read their file.
          throw new HttpError(400, 'import_failed', err.explanation);
        }
        throw err;
      }
    },
  );

  /** Confirm the mapping and validate every row against it. */
  server.put(
    '/v1/imports/:id/mapping',
    {
      schema: {
        tags: ['Imports'],
        summary: 'Confirm the column mapping and validate every row',
        params: IdParamSchema,
        body: ColumnMappingSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher', 'accountant');

      const { id } = request.params;

      const batch = await getBatch(s, id);
      if (!batch) throw new HttpError(404, 'not_found', 'That import no longer exists.');

      const text = (await app.storage.get(batch.storageKey)).toString('utf8');

      try {
        const updated = await applyMapping(s, id, request.body, text);
        const invalid = await listRows(s, id, { onlyInvalid: true, limit: 50 });
        return { batch: updated, invalidRows: invalid };
      } catch (err) {
        if (err instanceof ImportError) {
          throw new HttpError(409, 'import_failed', err.explanation);
        }
        throw err;
      }
    },
  );

  server.get(
    '/v1/imports',
    { schema: { tags: ['Imports'], summary: 'List import batches', querystring: PageQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const { cursor, limit } = request.query;
      try {
        return await listBatches(s, { ...(cursor ? { cursor } : {}), limit });
      } catch (err) {
        if (err instanceof CursorError) throw new HttpError(400, err.code, err.explanation);
        throw err;
      }
    },
  );

  server.get(
    '/v1/imports/:id',
    {
      schema: {
        tags: ['Imports'],
        summary: 'Get an import batch and its rows',
        params: IdParamSchema,
        querystring: BatchRowsQuerySchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      const { id } = request.params;
      const { onlyInvalid, limit } = request.query;

      const batch = await getBatch(s, id);
      if (!batch) throw new HttpError(404, 'not_found', 'That import no longer exists.');

      return {
        batch,
        rows: await listRows(s, id, {
          onlyInvalid: onlyInvalid === 'true',
          ...(limit ? { limit } : {}),
        }),
      };
    },
  );

  /**
   * Commit.
   *
   * Owner or accountant only. This writes the carrier's financial history, and
   * it is the data every later margin figure is measured against.
   */
  server.post(
    '/v1/imports/:id/commit',
    { schema: { tags: ['Imports'], summary: 'Commit a validated import batch', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'accountant');
      const { id } = request.params;

      try {
        const result = await commitImport(s, id);
        return { ...result, summary: await importedHistorySummary(s) };
      } catch (err) {
        if (err instanceof ImportError) {
          throw new HttpError(409, 'import_failed', err.explanation);
        }
        throw err;
      }
    },
  );

  // --- the exit gate -------------------------------------------------------

  /**
   * What the imported history says, next to what the carrier told us.
   *
   * The comparison is the point. A carrier whose stated cost is $1.35/mi and
   * whose imported history shows $1.28/mi in revenue is running at a loss on
   * their own numbers, and they should find that out here rather than after
   * HaulQ has spent a month recommending loads on those figures.
   */
  server.get(
    '/v1/imports/history-summary',
    { schema: { tags: ['Imports'], summary: 'Imported history vs. stated operating costs' } },
    async (request) => {
      const s = await requireScope(request);
      return importedHistorySummary(s);
    },
  );

  /**
   * Confirm the operating facts against the imported history.
   *
   * Phase 0's exit gate. Refused without enough history to mean anything — a
   * reconciliation against four loads is a rubber stamp, and the timestamp it
   * writes would then misrepresent how well-founded the numbers are.
   */
  server.post(
    '/v1/imports/reconcile',
    { schema: { tags: ['Imports'], summary: 'Confirm operating costs against imported history' } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'accountant');

      const summary = await importedHistorySummary(s);
      if (summary.loadCount < 20) {
        throw new HttpError(
          409,
          'not_enough_history',
          `Only ${summary.loadCount} imported loads. Import at least 20, ideally 30 to 90 days' worth, before confirming your cost figures against them.`,
        );
      }

      await markOperatingFactsReconciled(s, {
        loadCount: summary.loadCount,
        periodDays: summary.periodDays,
      });

      return { reconciled: true, summary };
    },
  );
}
