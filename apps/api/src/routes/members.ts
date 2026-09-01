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
  CursorError,
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
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

const RoleSchema = z.enum(['owner', 'dispatcher', 'driver', 'accountant']);

const InviteSchema = z.object({
  email: z.string().email(),
  role: RoleSchema.default('driver'),
});

const ChangeRoleSchema = z.object({ role: RoleSchema });

/**
 * Two independently-paginated lists on one screen, so each gets its own
 * cursor param rather than sharing one — `membersCursor` and
 * `invitationsCursor` page separately, the way `Members.tsx` actually
 * scrolls them (two sections, two "Load more" buttons).
 */
const MembersQuerySchema = z.object({
  membersCursor: z.string().optional(),
  membersLimit: z.coerce.number().int().min(1).max(200).optional(),
  invitationsCursor: z.string().optional(),
  invitationsLimit: z.coerce.number().int().min(1).max(200).optional(),
});

const InviteIdParamSchema = z.object({ id: z.string().uuid() });
const UserIdParamSchema = z.object({ userId: z.string().uuid() });
// Not `.uuid()` — an invitation token is an opaque secret, same reasoning as
// `track.ts`'s note on checkin/visibility tokens.
const TokenParamSchema = z.object({ token: z.string().min(1) });

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
  if (err instanceof CursorError) {
    throw new HttpError(400, err.code, err.explanation);
  }
  throw err;
}

export async function memberRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // --- inside a tenant -----------------------------------------------------

  server.get(
    '/v1/members',
    { schema: { tags: ['Members'], summary: 'List members and pending invitations', querystring: MembersQuerySchema } },
    async (request) => {
      const s = await requireScope(request);
      const q = request.query;

      try {
        const [members, invitations] = await Promise.all([
          listMembers(s, {
            ...(q.membersCursor ? { cursor: q.membersCursor } : {}),
            ...(q.membersLimit ? { limit: q.membersLimit } : {}),
          }),
          listInvitations(s, {
            ...(q.invitationsCursor ? { cursor: q.invitationsCursor } : {}),
            ...(q.invitationsLimit ? { limit: q.invitationsLimit } : {}),
          }),
        ]);
        return { members, invitations };
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/members/invites',
    { schema: { tags: ['Members'], summary: 'Invite someone', body: InviteSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');

      try {
        const result = await inviteMember(s, request.body, request.auth!.role);
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
    },
  );

  server.delete(
    '/v1/members/invites/:id',
    { schema: { tags: ['Members'], summary: 'Revoke an invitation', params: InviteIdParamSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');
      const { id } = request.params;

      try {
        await revokeInvitation(s, id);
        return reply.code(204).send();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.patch(
    '/v1/members/:userId',
    {
      schema: {
        tags: ['Members'],
        summary: "Change a member's role",
        params: UserIdParamSchema,
        body: ChangeRoleSchema,
      },
    },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner');
      const { userId } = request.params;

      try {
        await changeRole(s, { userId, role: request.body.role }, request.auth!.role);
        return { ok: true };
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.delete(
    '/v1/members/:userId',
    { schema: { tags: ['Members'], summary: 'Remove a member', params: UserIdParamSchema } },
    async (request, reply) => {
      const s = await requireScope(request);
      requireRole(request, 'owner');
      const { userId } = request.params;

      try {
        await removeMember(s, userId);
        return reply.code(204).send();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // --- without a tenant ----------------------------------------------------

  /**
   * What an invitation is for, before signing in.
   *
   * Unauthenticated on purpose: the recipient needs to see "Prairie Freight
   * invited you as a dispatcher" to decide whether to create an account at all.
   * Nothing is disclosed that the holder of the token does not already have.
   */
  server.get(
    '/v1/invitations/:token',
    { schema: { tags: ['Members'], summary: 'Preview an invitation', params: TokenParamSchema } },
    async (request) => {
      const { token } = request.params;
      try {
        return await previewInvitation(app.db, token);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  server.post(
    '/v1/invitations/:token/accept',
    { schema: { tags: ['Members'], summary: 'Accept an invitation', params: TokenParamSchema } },
    async (request) => {
      const { token } = request.params;

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
    },
  );

  /**
   * The accounts this person can act in.
   *
   * The web app calls this straight after sign-in: a session says who someone
   * is, this says which account they are working in. One login, several
   * carriers, for a driver who moves between them.
   */
  server.get(
    '/v1/orgs',
    { schema: { tags: ['Members'], summary: 'Accounts this person can act in' } },
    async (request) => {
      const authed = await app.authenticator.authenticateUser(request.headers);
      if (!authed) {
        throw new HttpError(401, 'unauthenticated', 'Sign in to see your accounts.');
      }
      return { items: await orgsForUser(app.db, authed.actor.id) };
    },
  );
}
