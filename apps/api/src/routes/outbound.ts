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
  OUTBOUND_ACTIONS,
  OutboundMessageSchema,
  UpdateOutboundSettingsSchema,
  clampMode,
  type OutboundMessage,
  type OutboundSettings,
} from '@haulq/contracts';
import {
  getOutboundSettings,
  listAllMembers,
  listOutbound,
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

const IdParamSchema = z.object({ id: z.string().uuid() });

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
    error: row.error,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

function rethrow(err: unknown): never {
  if (err instanceof OutboundError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'sending_disabled' ? 409 : err.code === 'wrong_state' ? 409 : 422;
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
      requireRole(request, 'owner', 'dispatcher');
      const stored = await getOutboundSettings(s);

      // Every registered action appears, with its effective mode: unset is
      // shadow, and a stored mode above the ceiling reads as the ceiling.
      const modes = Object.fromEntries(
        (Object.keys(OUTBOUND_ACTIONS) as Array<keyof typeof OUTBOUND_ACTIONS>).map((action) => [
          action,
          clampMode(action, (stored.modes[action] as 'shadow' | 'draft' | 'act' | undefined) ?? 'shadow'),
        ]),
      ) as OutboundSettings['modes'];

      return {
        sendingEnabled: stored.sendingEnabled,
        modes,
        actions: Object.entries(OUTBOUND_ACTIONS).map(([type, a]) => ({
          type,
          label: a.label,
          maxMode: a.maxMode,
        })),
      };
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
      requireRole(request, 'owner', 'dispatcher');
      const rows = await listOutbound(s, { status: request.query.status });
      return { messages: rows.map(toMessage) };
    },
  );

  server.post(
    '/v1/outbound/messages/:id/approve',
    { schema: { tags: ['Outbound'], summary: 'Approve a drafted message — it sends now', params: IdParamSchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      if (s.ctx.actor.type !== 'user') {
        throw new HttpError(403, 'forbidden', 'Only a person can approve a message.');
      }
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
      requireRole(request, 'owner', 'dispatcher');
      if (s.ctx.actor.type !== 'user') {
        throw new HttpError(403, 'forbidden', 'Only a person can reject a message.');
      }
      try {
        return toMessage(await rejectDraft(s, request.params.id, s.ctx.actor.id));
      } catch (err) {
        rethrow(err);
      }
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
