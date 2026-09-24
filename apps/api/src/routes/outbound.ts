/**
 * Outbound — settings, the message record, approvals, and a test send.
 * `FEATURE_REQUESTS_PLAN.md` section 8, piece 1.
 *
 * There is deliberately **no endpoint that sends an arbitrary message**.
 * Messages are created by the autonomous loops (piece 3) through
 * `outbound/dispatch.ts`; the API only lets a person configure how much
 * freedom the system has, review what it did or would do, and approve or
 * reject what it held. The one exception is `/test`, which can only email
 * the caller's own address — enough to prove the connection sends, with
 * no way to point it at anyone else.
 *
 * Not gated behind a plan tier: which tier this belongs to is a
 * commercial decision, not something to guess at here.
 */

import {
  ListOutboundQuerySchema,
  MarkOutboundSchema,
  OUTBOUND_ACTIONS,
  OUTBOUND_MONEY_ACTIONS,
  PROMOTION_EVIDENCE,
  OutboundActionTypeSchema,
  OutboundMessageSchema,
  UpdateOutboundSettingsSchema,
  clampMode,
  type OutboundMessage,
  type OutboundMode,
  type OutboundSettingsResponse,
} from '@haulq/contracts';
import {
  clearAutonomyMode,
  getOutbound,
  getOutboundSettings,
  listAllMembers,
  listOutbound,
  markOutbound,
  outboundEvidence,
  OutboundStateError,
  setAutonomyMode,
  setSendingEnabled,
  type OutboundMessageRow,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { approveOutbound, OutboundError, rejectDraft, sendAsCarrier } from '../outbound/dispatch.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';
import type { FastifyRequest } from 'fastify';

/**
 * Who reviews what. Owners and dispatchers see every message. An accountant
 * sees and approves the ones about money owed — invoices and payment
 * reminders — and gets a plain "not found" for the rest, the same answer as a
 * message that does not exist, so what a role may not read does not leak.
 */
function reviewer(request: FastifyRequest): { moneyOnly: boolean } {
  requireRole(request, 'owner', 'dispatcher', 'accountant');
  return { moneyOnly: request.auth?.role === 'accountant' };
}

async function assertMayReview(request: FastifyRequest, s: Parameters<typeof getOutbound>[0], id: string): Promise<void> {
  if (!reviewer(request).moneyOnly) return;
  const message = await getOutbound(s, id);
  if (message && !(OUTBOUND_MONEY_ACTIONS as readonly string[]).includes(message.actionType)) {
    throw new HttpError(404, 'not_found', 'That message no longer exists.');
  }
}

const IdParamSchema = z.object({ id: z.string().uuid() });
const ActionParamSchema = z.object({ actionType: OutboundActionTypeSchema });

function toMessage(row: OutboundMessageRow): OutboundMessage {
  return OutboundMessageSchema.parse({
    id: row.id,
    actionType: row.actionType,
    mode: row.mode,
    status: row.status,
    holdReason: row.holdReason,
    toAddresses: row.toAddresses,
    subject: row.subject,
    body: row.body,
    // Checksums stay server-side; the carrier sees what was attached, not how it was verified.
    attachments: row.attachments.map((a) => ({
      kind: a.kind,
      refId: a.refId,
      filename: a.filename,
      contentType: a.contentType,
      byteSize: a.byteSize,
    })),
    relatedType: row.relatedType,
    relatedId: row.relatedId,
    verdict: row.reviewVerdict === 'right' || row.reviewVerdict === 'wrong' ? row.reviewVerdict : null,
    verdictNote: row.reviewNote,
    error: row.error,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

function rethrow(err: unknown): never {
  if (err instanceof OutboundError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'sending_disabled' ? 409 : err.code === 'wrong_state' || err.code === 'expired' ? 409 : 422;
    throw new HttpError(status, err.code, err.message);
  }
  if (err instanceof OutboundStateError) {
    throw new HttpError(err.code === 'not_found' ? 404 : 409, err.code, err.message);
  }
  throw err;
}

export async function outboundRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/outbound/settings',
    { schema: { tags: ['Outbound'], summary: 'How much freedom the system has to send in your name' } },
    async (request) => {
      const s = await requireScope(request);
      reviewer(request);
      const stored = await getOutboundSettings(s);

      // Every registered action appears, with its effective mode: unset is
      // shadow, and a stored mode above the ceiling reads as the ceiling.
      // `configured` is what the carrier actually set — an action missing
      // from it is off, which `modes` cannot say (it reads as shadow).
      const keys = Object.keys(OUTBOUND_ACTIONS) as Array<keyof typeof OUTBOUND_ACTIONS>;
      const modes = Object.fromEntries(
        keys.map((action) => [action, clampMode(action, (stored.modes[action] as OutboundMode | undefined) ?? 'shadow')]),
      ) as OutboundSettingsResponse['modes'];
      const configured = Object.fromEntries(
        keys.filter((action) => stored.modes[action] !== undefined).map((action) => [action, modes[action]]),
      ) as OutboundSettingsResponse['configured'];

      const response: OutboundSettingsResponse = {
        sendingEnabled: stored.sendingEnabled,
        autopilotRunning: app.env.AUTOPILOT_POLL_MS > 0,
        modes,
        configured,
        actions: keys.map((type) => ({
          type,
          label: OUTBOUND_ACTIONS[type].label,
          maxMode: OUTBOUND_ACTIONS[type].maxMode,
          available: OUTBOUND_ACTIONS[type].available,
        })),
      };
      return response;
    },
  );

  server.put(
    '/v1/outbound/settings',
    { schema: { tags: ['Outbound'], summary: 'Change sending, or an action type\'s mode', body: UpdateOutboundSettingsSchema } },
    async (request) => {
      const s = await requireScope(request);
      // Owner only: how freely the system speaks for the business is the
      // owner's call, not a dispatcher's.
      requireRole(request, 'owner');
      const { sendingEnabled, modes } = request.body;

      try {
        // Validate everything before writing anything, so a rejected mode
        // cannot leave the switch half-applied.
        for (const [action, mode] of Object.entries(modes ?? {})) {
          const key = action as keyof typeof OUTBOUND_ACTIONS;
          if (clampMode(key, mode) !== mode) {
            throw new HttpError(
              422,
              'above_ceiling',
              `"${OUTBOUND_ACTIONS[key].label}" can be at most "${OUTBOUND_ACTIONS[key].maxMode}".`,
            );
          }
        }

        if (sendingEnabled !== undefined) await setSendingEnabled(s, sendingEnabled);
        for (const [action, mode] of Object.entries(modes ?? {})) {
          await setAutonomyMode(s, action, mode);
        }
      } catch (err) {
        rethrow(err);
      }
      return { ok: true };
    },
  );

  server.delete(
    '/v1/outbound/settings/:actionType',
    {
      schema: {
        tags: ['Outbound'],
        summary: 'Turn an action off — the system stops preparing it at all',
        params: ActionParamSchema,
      },
    },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner');
      await clearAutonomyMode(s, request.params.actionType);
      return reply.code(204).send();
    },
  );

  server.get(
    '/v1/outbound/messages',
    {
      schema: {
        tags: ['Outbound'],
        summary: 'Everything sent, drafted or held in your name',
        querystring: ListOutboundQuerySchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      const { moneyOnly } = reviewer(request);
      const rows = await listOutbound(s, {
        status: request.query.status,
        actionTypes: moneyOnly ? OUTBOUND_MONEY_ACTIONS : undefined,
      });
      return { messages: rows.map(toMessage) };
    },
  );

  server.post(
    '/v1/outbound/messages/:id/approve',
    { schema: { tags: ['Outbound'], summary: 'Approve a drafted message — it sends now', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      reviewer(request);
      if (s.ctx.actor.type !== 'user') {
        throw new HttpError(403, 'forbidden', 'Only a person can approve a message.');
      }
      await assertMayReview(request, s, request.params.id);
      try {
        return toMessage(await approveOutbound({ unipile: app.unipileClient, storage: app.storage, log: app.log }, s, request.params.id, s.ctx.actor.id));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/outbound/messages/:id/reject',
    { schema: { tags: ['Outbound'], summary: 'Reject a drafted message', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      reviewer(request);
      if (s.ctx.actor.type !== 'user') {
        throw new HttpError(403, 'forbidden', 'Only a person can reject a message.');
      }
      await assertMayReview(request, s, request.params.id);
      try {
        return toMessage(await rejectDraft(s, request.params.id, s.ctx.actor.id));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  /**
   * Was this preview what you would have wanted sent? The carrier's own
   * evidence for moving an action up. Only a preview can be marked; an
   * approval or rejection is already a verdict on a held draft.
   */
  server.post(
    '/v1/outbound/messages/:id/mark',
    {
      schema: {
        tags: ['Outbound'],
        summary: 'Mark a preview right or wrong',
        params: IdParamSchema,
        body: MarkOutboundSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      reviewer(request);
      if (s.ctx.actor.type !== 'user') {
        throw new HttpError(403, 'forbidden', 'Only a person can mark a message.');
      }
      await assertMayReview(request, s, request.params.id);
      const marked = await markOutbound(s, request.params.id, s.ctx.actor.id, request.body.verdict, request.body.note);
      if (marked) return toMessage(marked);
      const existing = await getOutbound(s, request.params.id);
      if (!existing) throw new HttpError(404, 'not_found', 'That message no longer exists.');
      throw new HttpError(409, 'wrong_state', 'Only a preview can be marked right or wrong.');
    },
  );

  /**
   * What the carrier's own history says about each action, for the "ready to
   * move up?" prompt. An accountant sees only the actions they may review.
   */
  server.get(
    '/v1/outbound/evidence',
    { schema: { tags: ['Outbound'], summary: 'How previews and approvals have gone, per action' } },
    async (request) => {
      const s = await requireScope(request);
      const { moneyOnly } = reviewer(request);
      return {
        actions: await outboundEvidence(s, {
          window: PROMOTION_EVIDENCE.window,
          actionTypes: moneyOnly ? OUTBOUND_MONEY_ACTIONS : undefined,
        }),
      };
    },
  );

  server.post(
    '/v1/outbound/test',
    { schema: { tags: ['Outbound'], summary: 'Send yourself a test message through the same path everything else uses' } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner');
      if (s.ctx.actor.type !== 'user') {
        throw new HttpError(403, 'forbidden', 'Only a person can send a test message.');
      }
      const actorId = s.ctx.actor.id;

      const members = await listAllMembers(s);
      const me = members.find((m) => m.userId === actorId);
      if (!me?.email) {
        throw new HttpError(409, 'no_address', 'Could not find an email address for you to send the test to.');
      }

      try {
        const result = await sendAsCarrier({ unipile: app.unipileClient, storage: app.storage, log: app.log }, s, {
          actionType: 'test',
          to: [me.email],
          subject: 'HaulQ test message',
          body: 'This is a test message sent through HaulQ from your connected mailbox. If it arrived, sending works.',
        });
        return { message: toMessage(result.message), sent: result.sent };
      } catch (err) {
        rethrow(err);
      }
    },
  );
}
