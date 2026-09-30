/**
 * People: who can act in this account, and who has been asked to. Web's
 * `Members.tsx` on a phone (MOBILE_PARITY_PLAN.md M4).
 *
 * Two lists, as on web. A member has access; an invitation is a promise of
 * access nobody has taken up, and folding them together hides the thing an
 * owner needs to see: invitations sitting unaccepted for a week.
 *
 * What each person may do comes from `memberControls` and `invitableRoles`
 * in `@haulq/client`. The repository is what refuses (last owner, owner-only
 * role changes); this screen hides what would bounce and says why.
 *
 * Invitations go out as a link through the share sheet (`InviteLink`).
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
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useOrgs, useSession } from '../../components/AuthGate.tsx';
import { InviteLink } from '../../components/InviteLink.tsx';
import { Card, Empty, ErrorNote, Field, LoadMore, Pill } from '../../components/ui.tsx';

export function PeopleScreen() {
  const session = useSession();
  // From `/v1/orgs`: the session's user id can be a placeholder under Clerk,
  // which never matched your own row.
  const orgs = useOrgs();
  const me = { userId: orgs.data?.userId ?? session?.userId, role: session?.role };
  const members = useMembers();
  const invitations = useInvitations();
  const memberList = members.data?.pages.flatMap((p) => p.members.items) ?? [];
  const inviteList = invitations.data?.pages.flatMap((p) => p.invitations.items) ?? [];
  const ownerCount = memberList.filter((m) => m.role === 'owner').length;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ More
      </Link>
      <h1 className="text-2xl">People</h1>
      <p className="text-sm text-slate">Roles take effect right away, not at their next sign-in.</p>

      {canDispatch(me.role) && <InviteForm myRole={me.role} />}

      <Card title="Members">
        {members.isError && <ErrorNote error={members.error} />}
        {members.isLoading && <Empty>Loading…</Empty>}
        <ul className="divide-y divide-line">
          {memberList.map((m) => (
            <li key={m.userId} className="py-3">
              <MemberRow member={m} me={me} ownerCount={ownerCount} />
            </li>
          ))}
        </ul>
        <LoadMore onClick={() => void members.fetchNextPage()} loading={members.isFetchingNextPage} hasMore={members.hasNextPage} />
      </Card>

      <Card title="Invited, not joined yet">
        {invitations.isError && <ErrorNote error={invitations.error} />}
        {invitations.isSuccess && inviteList.length === 0 && <Empty>No invitations waiting.</Empty>}
        <ul className="divide-y divide-line">
          {inviteList.map((i) => (
            <li key={i.id} className="py-3">
              <InvitationRow invitation={i} canWithdraw={canDispatch(me.role)} />
            </li>
          ))}
        </ul>
        <LoadMore
          onClick={() => void invitations.fetchNextPage()}
          loading={invitations.isFetchingNextPage}
          hasMore={invitations.hasNextPage}
        />
      </Card>
    </div>
  );
}

function InviteForm({ myRole }: { myRole: string | undefined }) {
  const roles = invitableRoles(myRole);
  const invite = useInvite();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('driver');
  const [driverId, setDriverId] = useState('');
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);
  // A driver invite can name the roster row this login will control.
  const drivers = useDriverList();
  const unlinked = (drivers.data?.pages.flatMap((p) => p.items) ?? []).filter((d) => !d.userId);

  if (issued) return <InviteLink email={issued.email} token={issued.token} onDone={() => setIssued(null)} />;

  return (
    <Card title="Invite someone">
      <div className="space-y-3">
        <Field label="Email">
          <input
            className="hq-input"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
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
          <Field label="Which driver" hint="Links their login to the roster, so they see their loads as soon as they join.">
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
        <button
          type="button"
          className="hq-btn hq-btn-brand w-full"
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
          {invite.isPending ? 'Creating…' : 'Create invite link'}
        </button>
        <ErrorNote error={invite.error} />
      </div>
    </Card>
  );
}

function MemberRow({
  member,
  me,
  ownerCount,
}: {
  member: Member;
  me: { userId: string | undefined; role: string | undefined };
  ownerCount: number;
}) {
  const controls = memberControls(member, me, ownerCount);
  const changeRole = useChangeRole();
  const remove = useRemoveMember();
  const [confirming, setConfirming] = useState(false);
  const isYou = member.userId === me.userId;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {member.fullName ?? <span className="text-mute">No name yet</span>}
            {isYou && <span className="text-mute"> · you</span>}
          </p>
          <p className="break-all text-xs text-mute">{isPlaceholderEmail(member.email) ? 'Address not synced yet' : member.email}</p>
        </div>
        {!controls.changeRole && <Pill tone={member.role === 'owner' ? 'ok' : 'neutral'}>{ROLE_LABEL[member.role]}</Pill>}
      </div>

      {controls.changeRole && (
        <select
          aria-label={`Role for ${member.fullName ?? member.email}`}
          className="hq-input"
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
      )}
      {controls.lastOwner && <p className="text-xs text-mute">The only owner. Make someone else an owner first.</p>}

      {controls.remove && !confirming && (
        <button type="button" className="text-sm text-bad" onClick={() => setConfirming(true)}>
          Remove from the account
        </button>
      )}
      {confirming && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="hq-btn flex-1 bg-bad py-1.5 text-sm text-white"
            disabled={remove.isPending}
            onClick={() => remove.mutate(member.userId, { onSuccess: () => setConfirming(false) })}
          >
            {remove.isPending ? 'Removing…' : 'Remove'}
          </button>
          <button type="button" className="hq-btn hq-btn-ghost py-1.5 text-sm" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      )}
      <ErrorNote error={changeRole.error ?? remove.error} />
    </div>
  );
}

function InvitationRow({ invitation, canWithdraw }: { invitation: Invitation; canWithdraw: boolean }) {
  const revoke = useRevokeInvitation();
  const expiry = invitationExpiry(invitation.expiresAt);
  const color = expiry.tone === 'bad' ? 'text-bad' : expiry.tone === 'warn' ? 'text-warn' : 'text-mute';

  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-all font-medium">{invitation.email}</p>
        <Pill>{ROLE_LABEL[invitation.role]}</Pill>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className={`text-sm ${color}`}>{expiry.label}</span>
        {canWithdraw && (
          <button type="button" className="text-sm text-bad" disabled={revoke.isPending} onClick={() => revoke.mutate(invitation.id)}>
            {revoke.isPending ? 'Withdrawing…' : 'Withdraw'}
          </button>
        )}
      </div>
      <ErrorNote error={revoke.error} />
    </div>
  );
}
