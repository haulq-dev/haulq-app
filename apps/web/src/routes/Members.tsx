/**
 * Who can act in this carrier's account, and who has been asked to.
 *
 * Two lists rather than one. A member has access; an invitation is a promise of
 * access that has not been taken up, and merging them into a single table with
 * a "pending" badge hides the thing an owner actually needs to see — that three
 * invitations have been sitting unaccepted for a week.
 *
 * The rules below are enforced in `packages/db/src/repositories/members.ts`, not
 * here. This screen disables controls to explain why an action is unavailable;
 * the repository is what refuses it. A UI-only rule is a rule the next surface
 * forgets.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  isPlaceholderEmail,
  request,
  ROLES,
  type Invitation,
  type Member,
  type MembersResponse,
  type Role,
} from '../lib/api.ts';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, Pill } from '../components/ui.tsx';

const ROLE_HINT: Record<Role, string> = {
  owner: 'Everything, including billing, members and the carrier authority.',
  dispatcher: 'Books loads, manages trucks and drivers. No billing.',
  driver: 'Their own loads and documents.',
  accountant: 'Invoices, settlements and reports. Cannot book.',
};

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Days until `iso`, negative once it has passed. */
function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/**
 * The invitation token, shown exactly once.
 *
 * `POST /v1/members/invites` returns it and the database keeps only a SHA-256
 * hash, so there is no second chance to read it — losing it means revoking and
 * re-inviting. That is why this is a full-width panel with a copy button rather
 * than a toast, and why it does not auto-dismiss.
 *
 * There is deliberately no accept link here. `/v1/invitations/:token/accept`
 * exists on the API, but the web app has no screen mounted at that path yet, so
 * a constructed URL would 404 and look like a broken invitation rather than a
 * missing feature.
 */
function TokenPanel({ email, token }: { email: string; token: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is denied over plain http and in some embedded
      // browsers. The token is selectable text either way, so this is a
      // convenience failing, not the feature failing.
      setCopied(false);
    }
  };

  return (
    <div className="border-l-2 border-brand bg-brand-50 p-4">
      <p className="field-label text-brand">Send this to {email}</p>
      <p className="mt-2 max-w-prose text-sm text-slate">
        This is the only time this token is shown — only its hash is stored. If
        it is lost, revoke the invitation and send a new one.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="num min-w-0 flex-1 border border-line bg-white px-3 py-2 text-xs break-all">
          {token}
        </code>
        <button className="hq-btn hq-btn-primary shrink-0" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-2 text-xs text-mute">
        Delivery is manual until email sending is wired up, at which point the
        invitation sends itself and this panel goes away.
      </p>
    </div>
  );
}

function InviteForm({ canInviteOwner }: { canInviteOwner: boolean }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('driver');
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);

  const queryClient = useQueryClient();
  const invite = useMutation({
    mutationFn: () =>
      request<{ invitation: Invitation; token: string }>('/v1/members/invites', {
        body: { email, role },
      }),
    onSuccess: async (res) => {
      setIssued({ email: res.invitation.email, token: res.token });
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });

  return (
    <Card title="Invite someone">
      <p className="mb-4 max-w-prose text-sm text-slate">
        You invite an email address, not an existing user — most people you
        invite will not have a HaulQ account yet. Whoever holds the link joins,
        even if they sign in with a different address, and both are recorded on
        the timeline.
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Email">
          <input
            className="hq-input"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Role" hint={ROLE_HINT[role]}>
          <select
            className="hq-input"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r} disabled={r === 'owner' && !canInviteOwner}>
                {r}
                {r === 'owner' && !canInviteOwner ? ' — owners only' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-5">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!email || invite.isPending}
          onClick={() => invite.mutate()}
        >
          {invite.isPending ? 'Sending…' : 'Create invitation'}
        </button>
      </div>

      <ErrorNote error={invite.error} />

      {issued && (
        <div className="mt-5">
          <TokenPanel email={issued.email} token={issued.token} />
        </div>
      )}
    </Card>
  );
}

function MemberRow({
  member,
  isYou,
  canManage,
  ownerCount,
}: {
  member: Member;
  isYou: boolean;
  canManage: boolean;
  ownerCount: number;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members'] });

  const changeRole = useMutation({
    mutationFn: (role: Role) =>
      request(`/v1/members/${member.userId}`, { method: 'PATCH', body: { role } }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: () =>
      request(`/v1/members/${member.userId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  // The last owner cannot be demoted or removed: it would leave an account
  // nobody can administer, and no screen exists that could fix it.
  const lastOwner = member.role === 'owner' && ownerCount <= 1;

  return (
    <tr>
      <td>
        <span className="block font-medium">
          {member.fullName ?? <span className="text-mute">No name yet</span>}
          {isYou && <span className="field-label ml-2 text-mute">you</span>}
        </span>
        <span className="block text-xs break-all text-mute">
          {isPlaceholderEmail(member.email) ? 'Address not synced yet' : member.email}
        </span>
      </td>
      <td>
        {canManage && !lastOwner ? (
          <select
            className="hq-input w-auto py-1 text-sm"
            value={member.role}
            disabled={changeRole.isPending}
            onChange={(e) => changeRole.mutate(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <Pill tone={member.role === 'owner' ? 'ok' : 'neutral'}>{member.role}</Pill>
        )}
        {lastOwner && (
          <span className="mt-1 block text-xs text-mute">
            The only owner. Promote someone else first.
          </span>
        )}
      </td>
      <td className="text-slate">{when(member.acceptedAt)}</td>
      <td>
        {canManage && !lastOwner && !isYou && (
          <button
            className="hq-btn hq-btn-ghost text-bad"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Removing…' : 'Remove'}
          </button>
        )}
        <ErrorNote error={changeRole.error ?? remove.error} />
      </td>
    </tr>
  );
}

function InvitationRow({ invitation, canManage }: { invitation: Invitation; canManage: boolean }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () =>
      request(`/v1/members/invites/${invitation.id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members'] }),
  });

  const left = daysUntil(invitation.expiresAt);

  return (
    <tr>
      <td className="font-medium break-all">{invitation.email}</td>
      <td>
        <Pill>{invitation.role}</Pill>
      </td>
      <td>
        {left < 0 ? (
          <span className="text-sm text-bad">Expired</span>
        ) : left <= 2 ? (
          <span className="text-sm text-warn">
            {left === 0 ? 'Expires today' : `${left}d left`}
          </span>
        ) : (
          <span className="text-sm text-slate">{left}d left</span>
        )}
      </td>
      <td>
        {canManage && (
          <button
            className="hq-btn hq-btn-ghost text-bad"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {revoke.isPending ? 'Withdrawing…' : 'Withdraw'}
          </button>
        )}
        <ErrorNote error={revoke.error} />
      </td>
    </tr>
  );
}

export function MembersScreen() {
  const session = useSession();
  const orgs = useOrgs();

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => request<MembersResponse>('/v1/members'),
  });

  /**
   * The caller's role in the carrier they are currently in.
   *
   * Read from `/v1/orgs` rather than stored in the session, for the same reason
   * the API re-reads membership on every request: a role change has to take
   * effect without the person signing out and back in.
   */
  const myRole = orgs.data?.items.find((o) => o.id === session?.orgId)?.role as
    | Role
    | undefined;

  const canInvite = myRole === 'owner' || myRole === 'dispatcher';
  const canManage = myRole === 'owner';

  const list = members.data?.members ?? [];
  const invitations = members.data?.invitations ?? [];
  const ownerCount = list.filter((m) => m.role === 'owner').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl">People</h1>
        <p className="mt-1 max-w-prose text-slate">
          Who can act in this account. Roles decide what each person sees and
          can do, and they are read fresh on every request — a change takes
          effect immediately, not at their next sign-in.
        </p>
      </div>

      {canInvite ? (
        <InviteForm canInviteOwner={canManage} />
      ) : (
        <Card>
          <p className="text-sm text-slate">
            Only an owner or dispatcher can invite people. You are signed in as{' '}
            <strong>{myRole ?? 'a member'}</strong>.
          </p>
        </Card>
      )}

      <Card title="Members">
        {members.isError && <ErrorNote error={members.error} />}
        {members.data && list.length === 0 && <Empty>Nobody here yet.</Empty>}

        {list.length > 0 && (
          <div className="overflow-x-auto">
            <table className="hq-table">
              <thead>
                <tr>
                  <th className="field-label">Person</th>
                  <th className="field-label">Role</th>
                  <th className="field-label">Joined</th>
                  <th className="field-label" />
                </tr>
              </thead>
              <tbody>
                {list.map((member) => (
                  <MemberRow
                    key={member.userId}
                    member={member}
                    isYou={member.userId === session?.userId}
                    canManage={canManage}
                    ownerCount={ownerCount}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Invited, not yet joined">
        {members.data && invitations.length === 0 && (
          <Empty>No invitations outstanding.</Empty>
        )}

        {invitations.length > 0 && (
          <div className="overflow-x-auto">
            <table className="hq-table">
              <thead>
                <tr>
                  <th className="field-label">Email</th>
                  <th className="field-label">Role</th>
                  <th className="field-label">Expires</th>
                  <th className="field-label" />
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <InvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    canManage={canInvite}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
