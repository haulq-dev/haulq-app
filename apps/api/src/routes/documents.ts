/**
 * Document intake.
 *
 * Same raw-body shape as `/v1/imports`, for the same reason: a browser can post
 * a `File` straight as a fetch body, and this endpoint takes exactly one file
 * and never a mixed form. Multipart would buy a dependency and a parser and
 * nothing else.
 *
 * ---------------------------------------------------------------------------
 * The digest is computed before anything is stored
 * ---------------------------------------------------------------------------
 *
 * `documents_org_sha_key` makes a repeat send produce one row. Hashing first
 * makes it produce one *upload* as well: a broker who re-sends the same rate
 * confirmation four times costs four hashes and zero writes to R2. That matters
 * because email intake is at-least-once by design and will be the loudest
 * source of repeats once it lands.
 *
 * Two uploads racing the same digest still both store, because the pre-check
 * cannot be transactional with an object store. The loser is told by
 * `createDocument` and deletes what it just wrote — see the note there.
 */

import { randomUUID } from 'node:crypto';
import {
  attachToLoad,
  createDocument,
  documentCounts,
  DocumentError,
  findDocumentBySha,
  getDocument,
  key as storageKey,
  listDocuments,
  recordManualFields,
  sha256,
  type Document,
} from '@haulq/db';
import {
  DocumentKindSchema,
  FIELD_METADATA,
  FIELD_NAMES_BY_KIND,
  ManualFieldsSchema,
  parseCount,
  parseMoney,
  type DocumentKind,
  type ExtractedField,
} from '@haulq/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';
import { safeFilename, sniff, SUPPORTED_DOCUMENT_TYPES } from '../documents/sniff.ts';
import { validateDocument } from '../documents/validate.ts';

/**
 * 25 MB.
 *
 * A scanned 40-page carrier packet is the realistic ceiling and lands near 15.
 * Above this is a photo album or a mistake, and the extractor's per-page cost
 * makes "let it through and find out" the expensive option.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the API returns for a document.
 *
 * `storageKey` is deliberately not in it. It is an R2 path containing the org
 * id, it is of no use to a client that fetches bytes through `/content`, and
 * every field that leaves here is a field that has to keep being true.
 */
function present(d: Document) {
  const { storageKey: _omitted, ...rest } = d;
  return rest;
}

export async function documentRoutes(app: FastifyInstance) {
  // Scoped to this plugin: Fastify encapsulates content type parsers, so the
  // csv parser on /v1/imports and this one do not see each other.
  app.addContentTypeParser(
    [...SUPPORTED_DOCUMENT_TYPES, 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  /**
   * Upload a document.
   *
   * Drivers can upload — a POD photographed at the dock is the single most
   * common intake path, and a role check that excludes them would push it back
   * to email.
   */
  app.post('/v1/documents', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher', 'driver', 'accountant');

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new HttpError(
        400,
        'invalid_request',
        'Send the file as the request body, with its content type set.',
      );
    }

    // The bytes decide what this is, not the header. See documents/sniff.ts.
    const contentType = sniff(body);
    if (!contentType) {
      throw new HttpError(
        415,
        'unsupported_file',
        'HaulQ can read PDFs, JPEGs, PNGs, TIFFs and iPhone photos. That file is none of those.',
      );
    }

    const q = request.query as { filename?: string; loadId?: string; kind?: string };
    const filename = safeFilename(q.filename, 'document.pdf');

    if (q.loadId && !UUID_RE.test(q.loadId)) {
      throw new HttpError(400, 'invalid_request', 'That is not a valid load id.');
    }

    let kind;
    if (q.kind !== undefined) {
      const parsed = DocumentKindSchema.safeParse(q.kind);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_request',
          `HaulQ does not have a document type called "${q.kind}".`,
        );
      }
      kind = parsed.data;
    }

    const digest = sha256(body);

    // The cheap path. A repeat send does not touch the object store at all.
    const already = await findDocumentBySha(s, digest);
    if (already) {
      return reply.code(200).send({ document: present(already), deduped: true });
    }

    const id = randomUUID();
    const key = storageKey({ orgId: s.ctx.orgId, kind: 'documents', id, filename });
    await app.storage.put(key, body, contentType);

    try {
      const { document, deduped } = await createDocument(s, {
        storageKey: key,
        sha256: digest,
        source: 'upload',
        contentType,
        filename,
        byteSize: body.byteLength,
        ...(kind ? { kind } : {}),
        ...(q.loadId ? { loadId: q.loadId } : {}),
      });

      if (deduped) {
        // Lost a race with a concurrent upload of the same bytes. The row we
        // are returning points at the winner's object, so this one is
        // unreferenced from the moment it was written.
        await app.storage.delete(key).catch((err: unknown) => {
          request.log.warn({ err, key }, 'could not remove a deduped upload');
        });
        return reply.code(200).send({ document: present(document), deduped: true });
      }

      return reply.code(201).send({ document: present(document), deduped: false });
    } catch (err) {
      // The row was not written, so nothing points at these bytes. Unlike the
      // import path — which keeps the file as evidence of what the carrier
      // sent — a rejected document has a digest we can ask them to re-send.
      await app.storage.delete(key).catch(() => {});

      if (err instanceof DocumentError) {
        throw new HttpError(
          err.code === 'load_not_found' ? 404 : 409,
          err.code,
          err.explanation,
        );
      }
      throw err;
    }
  });

  /** The inbox. Newest first; `unattached=true` is the view that gets worked. */
  app.get('/v1/documents', async (request) => {
    const s = await requireScope(request);
    const q = request.query as {
      loadId?: string;
      unattached?: string;
      status?: string;
      kind?: string;
      limit?: string;
    };

    const items = await listDocuments(s, {
      ...(q.loadId ? { loadId: q.loadId } : {}),
      ...(q.unattached === 'true' ? { unattached: true } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });

    return { items: items.map(present) };
  });

  /** Registered before `/:id` so the router does not read "counts" as an id. */
  app.get('/v1/documents/counts', async (request) => {
    const s = await requireScope(request);
    return { counts: await documentCounts(s) };
  });

  app.get('/v1/documents/:id', async (request) => {
    const s = await requireScope(request);
    const { id } = request.params as { id: string };
    const found = await getDocument(s, id);
    if (!found) throw new HttpError(404, 'not_found', 'That document is not in this account.');
    return { document: present(found) };
  });

  /**
   * The bytes.
   *
   * Served through the API rather than as a signed R2 URL. A presigned link is
   * a bearer token for one tenant's file that survives being pasted into a
   * chat, and the volume here — a person opening a document to look at it —
   * does not justify that trade. It can change when Docs starts serving whole
   * packets.
   */
  app.get('/v1/documents/:id/content', async (request, reply: FastifyReply) => {
    const s = await requireScope(request);
    const { id } = request.params as { id: string };

    const found = await getDocument(s, id);
    if (!found) throw new HttpError(404, 'not_found', 'That document is not in this account.');

    let body: Buffer;
    try {
      body = await app.storage.get(found.storageKey);
    } catch (err) {
      // The row outliving its object means a bucket was swapped or a lifecycle
      // rule fired. Worth a distinct code: it is an operational problem, not a
      // missing document, and it should not read to the carrier as one.
      request.log.error({ err, id, store: app.storage.name }, 'document bytes are missing');
      throw new HttpError(
        410,
        'content_missing',
        'That document is recorded but its file is no longer in storage. Please re-send it.',
      );
    }

    return reply
      .header('content-type', found.contentType ?? 'application/octet-stream')
      .header(
        'content-disposition',
        `inline; filename="${safeFilename(found.filename ?? undefined, 'document')}"`,
      )
      // The bytes are immutable — the digest is the identity of the row.
      .header('cache-control', 'private, max-age=300')
      .send(body);
  });

  /**
   * Hang a document on a load.
   *
   * Not open to drivers. A driver uploading a POD names the load at upload
   * time; re-pointing paperwork at a different load afterwards is a dispatch
   * correction, and it changes what a packet contains.
   */
  app.post('/v1/documents/:id/attach', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher', 'accountant');

    const { id } = request.params as { id: string };
    const body = request.body as { loadId?: string } | undefined;

    if (!body?.loadId || !UUID_RE.test(body.loadId)) {
      throw new HttpError(400, 'invalid_request', 'Send a loadId to attach this to.');
    }

    try {
      await attachToLoad(s, id, body.loadId);

      /**
       * Validate here, inline.
       *
       * A rate confirmation usually arrives before its load exists, so the
       * pipeline could not compare it to anything and left it `extracted`.
       * Attaching is the moment the other half turns up. It is two row reads and
       * a pure comparison, so it costs the request almost nothing, and doing it
       * asynchronously would show the person who just attached the document a
       * verdict that is a second out of date.
       */
      const validation = await validateDocument(s, id);
      const document = await getDocument(s, id);

      return {
        document: document ? present(document) : null,
        validation:
          validation.status === 'validated'
            ? { outcome: validation.verdict.outcome, reason: validation.verdict.reason }
            : null,
      };
    } catch (err) {
      if (err instanceof DocumentError) {
        throw new HttpError(
          err.code === 'not_found' || err.code === 'load_not_found' ? 404 : 409,
          err.code,
          err.explanation,
        );
      }
      throw err;
    }
  });

  /**
   * Type in what a document says, for one automated reading couldn't get
   * through — a garbled text layer, an unfamiliar template, or a field the
   * rules genuinely missed. Not open to drivers, same reasoning as `/attach`:
   * this corrects dispatch records rather than intaking a photo at the dock.
   */
  app.post('/v1/documents/:id/manual-fields', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher', 'accountant');

    const { id } = request.params as { id: string };

    const parsed = ManualFieldsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', 'Send a fields object of name to typed-in value.');
    }

    const found = await getDocument(s, id);
    if (!found) throw new HttpError(404, 'not_found', 'That document is not in this account.');

    const known = new Set(FIELD_NAMES_BY_KIND[found.kind as DocumentKind] ?? []);
    const fields: Record<string, ExtractedField> = {};

    for (const [field, raw] of Object.entries(parsed.data.fields)) {
      if (!known.has(field)) {
        throw new HttpError(
          400,
          'unknown_field',
          `"${field}" is not a field HaulQ tracks on a ${found.kind.replace(/_/g, ' ')}.`,
        );
      }

      const meta = FIELD_METADATA[field];
      // Every name in `known` came from FIELD_NAMES_BY_KIND, which is derived
      // from the same rules FIELD_METADATA is checked against by a test —
      // this can only fail if that guard itself has been bypassed.
      if (!meta) throw new Error(`field ${field} has no display metadata`);

      const trimmed = raw.trim();
      const value =
        meta.type === 'money' ? parseMoney(trimmed) : meta.type === 'count' ? parseCount(trimmed) : trimmed;

      if (value === null || value === '') {
        throw new HttpError(
          400,
          'invalid_field_value',
          `"${raw}" does not look like a valid ${FIELD_METADATA[field]?.label.toLowerCase() ?? field}.`,
        );
      }

      fields[field] = { value, raw: trimmed, label: 'manual-entry' };
    }

    try {
      await recordManualFields(s, id, { fields });

      // Same pattern as /attach: a manual save is the moment the document
      // becomes readable, so re-checking it against its load inline (if it
      // has one) means the disagreement view is fresh without a second round
      // trip.
      const validation = found.loadId ? await validateDocument(s, id) : null;
      const document = await getDocument(s, id);

      return {
        document: document ? present(document) : null,
        validation:
          validation?.status === 'validated'
            ? { outcome: validation.verdict.outcome, reason: validation.verdict.reason }
            : null,
      };
    } catch (err) {
      if (err instanceof DocumentError) {
        throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.explanation);
      }
      throw err;
    }
  });
}
