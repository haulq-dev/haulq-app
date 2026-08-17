/**
 * Members, invitations and org switching.
 *
 * Two of these routes run without a tenant — previewing and accepting an
 * invitation — for the same reason `POST /v1/orgs` does: the request is what
 * establishes which tenant the person belongs to.
 */

import { z } from 'zod';
import {
  acceptInvitation,
  changeRole,
  inviteMember,
  listInvitations,
  listMembers,
  MemberError,
  orgsForUser,
  previewInvitation,
  removeMember,
  revokeInvitation,
} from '@haulq/db';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

const RoleSchema = z.enum(['owner', 'dispatcher', 'driver', 'accountant']);

const InviteSchema = z.object({
  email: z.string().email(),
  role: RoleSchema.default('driver'),
});

const ChangeRoleSchema = z.object({ role: RoleSchema });

/** MemberError carries the status distinction; this maps it to HTTP. */
const STATUS: Record<string, number> = {
  forbidden: 403,
  not_found: 404,
  already_member: 409,
  already_accepted: 409,
  last_owner: 409,
  revoked: 410,
  expired: 410,
  invalid_token: 404,
};

function rethrow(err: unknown): never {
  if (err instanceof MemberError) {
    throw new HttpError(STATUS[err.code] ?? 400, err.code, err.explanation);
  }
  throw err;
}

export async function memberRoutes(app: FastifyInstance) {
  // --- inside a tenant -----------------------------------------------------

  app.get('/v1/members', async (request) => {
    const s = await requireScope(request);
    return {
      members: await listMembers(s),
      invitations: await listInvitations(s),
    };
  });

  app.post('/v1/members/invites', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');

    const parsed = InviteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }

    try {
      const result = await inviteMember(s, parsed.data, request.auth!.role);
      return reply.code(201).send({
        invitation: result.invitation,
        /**
         * Returned once and never again — only the hash is stored.
         *
         * Today the caller is responsible for delivering it. Once Postmark is
         * wired the `member.invite_email` outbox topic sends it, and this field
         * can drop out of the response entirely.
         */
        token: result.token,
      });
    } catch (err) {
      rethrow(err);
    }
  });

  app.delete('/v1/members/invites/:id', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    try {
      await revokeInvitation(s, id);
      return reply.code(204).send();
    } catch (err) {
      rethrow(err);
    }
  });

  app.patch('/v1/members/:userId', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner');
    const { userId } = request.params as { userId: string };

    const parsed = ChangeRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_request', 'Send a role.');
    }

    try {
      await changeRole(s, { userId, role: parsed.data.role }, request.auth!.role);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  });

  app.delete('/v1/members/:userId', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner');
    const { userId } = request.params as { userId: string };

    try {
      await removeMember(s, userId);
      return reply.code(204).send();
    } catch (err) {
      rethrow(err);
    }
  });

  // --- without a tenant ----------------------------------------------------

  /**
   * What an invitation is for, before signing in.
   *
   * Unauthenticated on purpose: the recipient needs to see "Prairie Freight
   * invited you as a dispatcher" to decide whether to create an account at all.
   * Nothing is disclosed that the holder of the token does not already have.
   */
  app.get('/v1/invitations/:token', async (request) => {
    const { token } = request.params as { token: string };
    try {
      return await previewInvitation(app.db, token);
    } catch (err) {
      rethrow(err);
    }
  });

  app.post('/v1/invitations/:token/accept', async (request) => {
    const { token } = request.params as { token: string };

    // Authenticates a person, not a tenant — joining is what gives them one.
    // `authenticateUser` refuses agent actors, so a model cannot join a carrier.
    const authed = await app.authenticator.authenticateUser(request.headers);
    if (!authed) {
      throw new HttpError(
        401,
        'unauthenticated',
        'Sign in or create an account to accept this invitation.',
      );
    }

    try {
      return await acceptInvitation(app.db, {
        token,
        userId: authed.actor.id,
        userEmail: authed.actor.email ?? '',
        correlationId: randomUUID(),
      });
    } catch (err) {
      rethrow(err);
    }
  });

  /**
   * The accounts this person can act in.
   *
   * The web app calls this straight after sign-in: a session says who someone
   * is, this says which account they are working in. One login, several
   * carriers, for a driver who moves between them.
   */
  app.get('/v1/orgs', async (request) => {
    const authed = await app.authenticator.authenticateUser(request.headers);
    if (!authed) {
      throw new HttpError(401, 'unauthenticated', 'Sign in to see your accounts.');
    }
    return { items: await orgsForUser(app.db, authed.actor.id) };
  });
}
