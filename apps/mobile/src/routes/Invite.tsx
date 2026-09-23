/**
 * Accepting an invitation, inside the driver app itself.
 *
 * Ported from `apps/web/src/routes/Invite.tsx` — same three states, same
 * reasoning for showing the org/role before asking for sign-in rather than
 * a bare wall. What differs from web: no carrier picker to land in
 * afterwards (`AuthGate.tsx`'s own note on why v1 has none), so a
 * successful accept writes the session directly from the response and
 * navigates straight to "my loads" — and `AuthGate` unconditionally
 * requires Clerk (no dev-mode sign-in prompt to fall back to).
 */

import { SignIn } from '@clerk/clerk-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useSignedIn } from '../components/AuthGate.tsx';
import { Card, ErrorNote, Pill } from '../components/ui.tsx';
import { ApiRequestError, request, writeSession } from '../lib/api.ts';

interface InvitationPreview {
  orgName: string;
  role: string;
  expiresAt: string;
  /** The roster row this login will control, once linked. Null for an invite that didn't name one. */
  driverName: string | null;
}

interface AcceptResult {
  orgId: string;
}

export function InviteAcceptScreen() {
  const { token } = useParams({ from: '/invite/$token' });
  const signedIn = useSignedIn();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => request<InvitationPreview>(`/v1/invitations/${token}`),
    // A bad token is a permanent answer, not a transient one worth retrying.
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => request<AcceptResult>(`/v1/invitations/${token}/accept`, { method: 'POST' }),
    onSuccess: async (result) => {
      writeSession({ userId: 'clerk', orgId: result.orgId, orgName: preview.data?.orgName });
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
  });

  if (preview.isLoading) {
    return <Centered><p className="text-mute">Checking that invitation…</p></Centered>;
  }

  if (preview.isError) {
    const explanation =
      preview.error instanceof ApiRequestError
        ? preview.error.explanation
        : 'That invitation link could not be checked.';
    return (
      <Centered>
        <h1 className="mb-2 text-2xl">This invitation is not usable</h1>
        <p className="mb-4 text-slate">{explanation}</p>
        <p className="text-sm text-mute">
          Invitations expire after seven days and can be withdrawn. Ask your dispatcher to send a
          new one.
        </p>
      </Centered>
    );
  }

  const invite = preview.data!;

  return (
    <Centered>
      <p className="field-label mb-2 text-brand">You have been invited</p>
      <h1 className="mb-2 text-2xl">Join {invite.orgName}</h1>
      {invite.driverName && (
        <p className="mb-4 text-slate">
          As <Pill>{invite.driverName}</Pill>
        </p>
      )}

      <Card>
        {signedIn ? (
          <>
            <button
              className="hq-btn hq-btn-brand w-full"
              disabled={accept.isPending}
              onClick={() => accept.mutate()}
            >
              {accept.isPending ? 'Joining…' : `Join ${invite.orgName}`}
            </button>
            <ErrorNote error={accept.error} />
          </>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate">
              Sign in or create an account to accept. You will come straight back here.
            </p>
            {/* Hash routing keeps Clerk's steps on this URL, so the token
                survives the round trip. */}
            <SignIn routing="hash" />
          </>
        )}
      </Card>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-md px-6 py-16">{children}</div>;
}
