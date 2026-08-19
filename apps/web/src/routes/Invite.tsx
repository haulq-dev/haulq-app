/**
 * Accepting an invitation.
 *
 * The one screen a person can reach before they have an account, and usually
 * the first thing they ever see of HaulQ. So it shows what they are being
 * invited to *before* asking them to sign in — a bare sign-in wall with no
 * context is how an invitation gets closed and forgotten.
 *
 * Three states, all of them normal:
 *
 *  - **signed out** — preview, then Clerk's sign-in. The preview endpoint is
 *    unauthenticated by design; it discloses nothing the holder of the token
 *    does not already have.
 *  - **signed in** — preview, then one button.
 *  - **the link is no longer good** — expired, revoked or already used. Each
 *    gets the API's own sentence rather than a generic failure, because the
 *    three have completely different remedies.
 */

import { SignIn } from '@clerk/clerk-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useSignedIn } from '../components/AuthGate.tsx';
import { Card, ErrorNote, Pill } from '../components/ui.tsx';
import { usingClerk } from '../lib/auth.ts';
import {
  ApiRequestError,
  request,
  writeSession,
  type Role,
} from '../lib/api.ts';

interface InvitationPreview {
  orgName: string;
  email: string;
  role: Role;
  expiresAt: string;
}

interface AcceptResult {
  orgId: string;
  role: Role;
  /** True when they signed in with a different address than was invited. */
  emailMismatch: boolean;
}

const ROLE_HINT: Record<string, string> = {
  owner: 'Full access, including billing and members.',
  dispatcher: 'Books loads, manages trucks and drivers.',
  driver: 'Their own loads and documents.',
  accountant: 'Invoices, settlements and reports.',
};

export function InviteScreen() {
  const { token } = useParams({ from: '/invite/$token' });
  const signedIn = useSignedIn();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => request<InvitationPreview>(`/v1/invitations/${token}`),
    // A bad token is a permanent answer. Retrying it just delays the sentence
    // that explains what went wrong.
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () =>
      request<AcceptResult>(`/v1/invitations/${token}/accept`, { method: 'POST' }),
    onSuccess: async (result) => {
      // Land them in the carrier they just joined rather than on the picker.
      writeSession({
        userId: 'clerk',
        orgId: result.orgId,
        orgName: preview.data?.orgName ?? 'your carrier',
      });
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
        <h1 className="mb-2 text-3xl">This invitation is not usable</h1>
        <p className="mb-6 max-w-prose text-slate">{explanation}</p>
        <p className="max-w-prose text-sm text-mute">
          Invitations expire after seven days and can be withdrawn. Ask whoever
          invited you to send a new one — it takes them a moment.
        </p>
      </Centered>
    );
  }

  const invite = preview.data!;

  return (
    <Centered>
      <p className="field-label mb-2 text-brand">You have been invited</p>
      <h1 className="mb-2 text-3xl">Join {invite.orgName} on HaulQ</h1>
      <p className="mb-6 max-w-prose text-slate">
        Invited as <Pill>{invite.role}</Pill>{' '}
        <span className="ml-1">{ROLE_HINT[invite.role] ?? ''}</span>
      </p>

      <Card>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="field-label text-mute">Invitation sent to</dt>
            <dd className="mt-1 text-sm break-all">{invite.email}</dd>
          </div>
          <div>
            <dt className="field-label text-mute">Link expires</dt>
            <dd className="mt-1 text-sm">
              {new Date(invite.expiresAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </dd>
          </div>
        </dl>

        <div className="mt-6">
          {signedIn ? (
            <>
              <button
                className="hq-btn hq-btn-brand"
                disabled={accept.isPending}
                onClick={() => accept.mutate()}
              >
                {accept.isPending ? 'Joining…' : `Join ${invite.orgName}`}
              </button>
              <p className="mt-3 max-w-prose text-xs text-mute">
                You can accept while signed in as a different address than the
                one above — the link is what grants access, and both addresses
                are recorded on the account's timeline.
              </p>
              <ErrorNote error={accept.error} />
            </>
          ) : (
            <SignInPrompt />
          )}
        </div>
      </Card>
    </Centered>
  );
}

/**
 * Sign-in, after the context rather than before it.
 *
 * In dev builds there is no Clerk, so this says what to do instead of rendering
 * a component that cannot exist. That keeps the screen walkable on a laptop with
 * no Clerk account, which is the same property the dev authenticator exists for.
 */
function SignInPrompt() {
  if (!usingClerk) {
    return (
      <p className="max-w-prose text-sm text-slate">
        This build has no sign-in configured. Start a dev session from the bar at
        the top of the page, then reload this link to accept.
      </p>
    );
  }
  return (
    <>
      <p className="mb-4 max-w-prose text-sm text-slate">
        Sign in or create an account to accept. You will come straight back here.
      </p>
      {/* Hash routing keeps Clerk's steps on this URL, so the token survives the
          round trip and the invitation is still there afterwards. */}
      <SignIn routing="hash" />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-2xl px-6 py-16">{children}</div>;
}
