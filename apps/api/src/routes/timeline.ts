/**
 * The audit trail, read side.
 *
 * Guardrail 6 asks for an immutable log with human-readable explanations. The
 * append side is enforced in the database; this is the half a carrier can
 * actually see, which is the half that makes it useful rather than merely
 * defensible.
 *
 * There is no write endpoint here, and there will not be one. Events are
 * appended by the code performing the action, inside that action's transaction.
 * An endpoint that lets a client post arbitrary events is an endpoint that lets
 * a client forge history.
 */

import { readTimeline } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireScope } from '../plugins/request-context.ts';

const TimelineQuerySchema = z.object({
  // Digits only, checked here rather than left to `BigInt()` — an all-digit
  // string is the one shape `BigInt()` never throws on.
  before: z.string().regex(/^\d+$/, 'must be a sequence number from a previous page').optional(),
  limit: z.coerce.number().int().min(1).optional(),
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
});

export async function timelineRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/timeline',
    { schema: { tags: ['Timeline'], summary: 'Read the audit trail', querystring: TimelineQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const q = request.query;

      const entries = await readTimeline(s, {
        ...(q.before !== undefined ? { before: BigInt(q.before) } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.subjectType ? { subjectType: q.subjectType } : {}),
        ...(q.subjectId ? { subjectId: q.subjectId } : {}),
      });

      return {
        // seq is a bigint. Serialized as a string because JSON numbers lose
        // integer precision past 2^53, and a cursor that silently rounds is a
        // cursor that silently skips rows.
        items: entries.map((e) => ({ ...e, seq: e.seq.toString() })),
        nextCursor:
          entries.length > 0 ? entries[entries.length - 1]!.seq.toString() : null,
      };
    },
  );
}
