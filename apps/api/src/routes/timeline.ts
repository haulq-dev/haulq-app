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
import { HttpError, requireScope } from '../plugins/request-context.ts';

export async function timelineRoutes(app: FastifyInstance) {
  app.get('/v1/timeline', async (request) => {
    const s = await requireScope(request);
    const q = request.query as Record<string, string | undefined>;

    let before: bigint | undefined;
    if (q['before'] !== undefined) {
      try {
        before = BigInt(q['before']);
      } catch {
        throw new HttpError(
          400,
          'invalid_request',
          'The "before" cursor must be a sequence number from a previous page.',
        );
      }
    }

    const entries = await readTimeline(s, {
      ...(before !== undefined ? { before } : {}),
      ...(q['limit'] ? { limit: Number(q['limit']) } : {}),
      ...(q['subjectType'] ? { subjectType: q['subjectType'] } : {}),
      ...(q['subjectId'] ? { subjectId: q['subjectId'] } : {}),
    });

    return {
      // seq is a bigint. Serialized as a string because JSON numbers lose
      // integer precision past 2^53, and a cursor that silently rounds is a
      // cursor that silently skips rows.
      items: entries.map((e) => ({ ...e, seq: e.seq.toString() })),
      nextCursor:
        entries.length > 0 ? entries[entries.length - 1]!.seq.toString() : null,
    };
  });
}
