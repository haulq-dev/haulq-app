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
 * forgets. The display rules (`memberControls`, `invitableRoles`) and every
 * request come from `@haulq/client`, shared with the mobile app's People screen.
 */

import {
  canDispatch,
  invitableRoles,
  invitationExpiry,
  isPlaceholderEmail,
  memberControls,
  ROLE_HINT,
  ROLE_LABEL,
  ROLES,
  useChangeRole,
  useDriverList,
  useInvitations,
  useInvite,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  type Invitation,
  type Member,
  type Role,
} from '@haulq/client';
import { useState } from 'react';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, LoadMore, Pill } from '../components/ui.tsx';

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The invitation token, shown exactly once.
 *
 * `POST /v1/members/invites` returns it and the database keeps only a SHA-256
 * hash, so there is no second chance to read it — losing it means revoking and
 * re-inviting. That is why this is a full-width panel with a copy button rather
 * than a toast, and why it does not auto-dismiss.
 */
function TokenPanel({ email, token }: { email: string; token: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/invite/${encodeURIComponent(token)}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is denied over plain http and in some embedded
      // browsers. The link is selectable text either way.
      setCopied(false);
    }
  };

  return (
    <div className="border-l-2 border-brand bg-brand-50 p-4">
      <p className="field-label text-brand">Send this link to {email}</p>
      <p className="mt-2 max-w-prose text-sm text-slate">
        This is the only time this link is shown — only its hash is stored. If it is lost, withdraw the invitation and send a new one. It opens in the
        HaulQ app or a browser, whichever they have.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="num min-w-0 flex-1 border border-line bg-white px-3 py-2 text-xs break-all">{link}</code>
        <button className="hq-btn hq-btn-primary shrink-0" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function InviteForm({ myRole }: { myRole: string | undefined }) {
  const roles = invitableRoles(myRole);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('driver');
  const [driverId, setDriverId] = useState('');
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);
  const invite = useInvite();
  // A driver invite can name the roster row this login will control, so the
  // app knows which loads are theirs the moment they accept. Only rows no
  // login controls yet.
  const drivers = useDriverList();
  const unlinked = (drivers.data?.pages.flatMap((p) => p.items) ?? []).filter((d) => !d.userId);

  return (
    <Card title="Invite someone">
      <p className="mb-4 max-w-prose text-sm text-slate">
        You invite an email address, not an existing user — most people you invite will not have a HaulQ account yet. Whoever holds the link joins,
        even if they sign in with a different address, and both are recorded on the timeline.
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Email">
          <input className="hq-input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" hint={ROLE_HINT[role]}>
          <select
            className="hq-input"
            value={role}
            onChange={(e) => {
              setRole(e.target.value as Role);
              setDriverId('');
            }}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </Field>
        {role === 'driver' && unlinked.length > 0 && (
          <Field label="Driver" hint="Optional — link this login to a roster row now, so their loads show the moment they accept.">
            <select className="hq-input" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">Not linked yet</option>
              {unlinked.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="mt-5">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!email.trim() || invite.isPending}
          onClick={() =>
            invite.mutate(
              { email: email.trim(), role, ...(role === 'driver' && driverId ? { driverId } : {}) },
              {
                onSuccess: (res) => {
                  setIssued({ email: res.invitation.email, token: res.token });
                  setEmail('');
                  setDriverId('');
                },
              },
            )
          }
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

function MemberRow({ member, me, ownerCount }: { member: Member; me: { userId: string | undefined; role: string | undefined }; ownerCount: number }) {
  const controls = memberControls(member, me, ownerCount);
  const changeRole = useChangeRole();
  const remove = useRemoveMember();
  const isYou = member.userId === me.userId;

  return (
    <tr>
      <td>
        <span className="block font-medium">
          {member.fullName ?? <span className="text-mute">No name yet</span>}
          {isYou && <span className="field-label ml-2 text-mute">you</span>}
        </span>
        <span className="block text-xs break-all text-mute">{isPlaceholderEmail(member.email) ? 'Address not synced yet' : member.email}</span>
      </td>
      <td>
        {controls.changeRole ? (
          <select
            className="hq-input w-auto py-1 text-sm"
            value={member.role}
            disabled={changeRole.isPending}
            onChange={(e) => changeRole.mutate({ userId: member.userId, role: e.target.value as Role })}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        ) : (
          <Pill tone={member.role === 'owner' ? 'ok' : 'neutral'}>{ROLE_LABEL[member.role]}</Pill>
        )}
        {controls.lastOwner && <span className="mt-1 block text-xs text-mute">The only owner. Promote someone else first.</span>}
      </td>
      <td className="text-slate">{when(member.acceptedAt)}</td>
      <td>
        {controls.remove && (
          <button
            className="hq-btn hq-btn-ghost text-bad"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Remove ${member.fullName ?? member.email} from this account?`)) remove.mutate(member.userId);
            }}
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
  const revoke = useRevokeInvitation();
  const expiry = invitationExpiry(invitation.expiresAt);
  const color = expiry.tone === 'bad' ? 'text-bad' : expiry.tone === 'warn' ? 'text-warn' : 'text-slate';

  return (
    <tr>
      <td className="font-medium break-all">{invitation.email}</td>
      <td>
        <Pill>{ROLE_LABEL[invitation.role]}</Pill>
      </td>
      <td>
        <span className={`text-sm ${color}`}>{expiry.label}</span>
      </td>
      <td>
        {canManage && (
          <button className="hq-btn hq-btn-ghost text-bad" disabled={revoke.isPending} onClick={() => revoke.mutate(invitation.id)}>
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
  const members = useMembers();
  const invitationsQuery = useInvitations();

  /**
   * The caller's role in the carrier they are currently in. Read from
   * `/v1/orgs` rather than stored in the session, for the same reason the API
   * re-reads membership on every request: a role change has to take effect
   * without the person signing out and back in.
   */
  const myRole = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  // From `/v1/orgs`, not the session: under Clerk the session's user id is a
  // placeholder, so comparing against it never found your own row.
  const me = { userId: orgs.data?.userId ?? session?.userId, role: myRole };
  const canInvite = canDispatch(myRole);

  const list = members.data?.pages.flatMap((p) => p.members.items) ?? [];
  const invitations = invitationsQuery.data?.pages.flatMap((p) => p.invitations.items) ?? [];
  const ownerCount = list.filter((m) => m.role === 'owner').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl">People</h1>
        <p className="mt-1 max-w-prose text-slate">
          Who can act in this account. Roles decide what each person sees and can do, and they are read fresh on every request — a change takes effect
          immediately, not at their next sign-in.
        </p>
      </div>

      {canInvite ? (
        <InviteForm myRole={myRole} />
      ) : (
        <Card>
          <p className="text-sm text-slate">
            Only an owner or dispatcher can invite people. You are signed in as <strong>{myRole ? ROLE_LABEL[myRole as Role] : 'a member'}</strong>.
          </p>
        </Card>
      )}

      <Card title="Members">
        {members.isError && <ErrorNote error={members.error} />}
        {members.isLoading && <Empty>Loading…</Empty>}
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
                  <MemberRow key={member.userId} member={member} me={me} ownerCount={ownerCount} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <LoadMore onClick={() => void members.fetchNextPage()} loading={members.isFetchingNextPage} hasMore={members.hasNextPage} />
      </Card>

      <Card title="Invited, not yet joined">
        {invitationsQuery.isError && <ErrorNote error={invitationsQuery.error} />}
        {invitationsQuery.isLoading && <Empty>Loading…</Empty>}
        {invitationsQuery.data && invitations.length === 0 && <Empty>No invitations outstanding.</Empty>}

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
                  <InvitationRow key={invitation.id} invitation={invitation} canManage={canInvite} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <LoadMore
          onClick={() => void invitationsQuery.fetchNextPage()}
          loading={invitationsQuery.isFetchingNextPage}
          hasMore={invitationsQuery.hasNextPage}
        />
      </Card>
    </div>
  );
}
