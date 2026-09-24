/**
 * Sign-in, and picking which carrier you are working in.
 *
 * Two things happen here and they are deliberately separate:
 *
 *  1. **Who are you.** Clerk, when a publishable key is configured. Otherwise
 *     the dev bar, which is header-based and refuses to exist in production on
 *     the API side.
 *  2. **Which carrier.** Always HaulQ's — `GET /v1/orgs` lists the accounts
 *     this person has an active membership in, and the choice is stored
 *     locally. Clerk's Organizations feature is not used; see
 *     `packages/db/src/repositories/identity.ts`.
 *
 * Keeping them apart is what lets one login belong to two carriers, which a
 * driver moving between them actually needs.
 */

import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth,
  UserButton,
} from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  readSession,
  request,
  writeSession,
  type Session,
} from '../lib/api.ts';
import {
  CLERK_PUBLISHABLE_KEY,
  misconfigured,
  registerTokenGetter,
  usingClerk,
} from '../lib/auth.ts';
import { Logo } from './Logo.tsx';

/**
 * Paths that render for a signed-out visitor.
 *
 * An invitation link is opened by someone who has no HaulQ account yet — that
 * is the normal case, not the edge one. Bouncing them to a sign-in screen with
 * no explanation of what they are signing in to is how an invitation gets
 * ignored.
 *
 * `/track/` is the same shape for a different visitor: a broker watching a
 * load was never meant to have a HaulQ account at all — PHASE_2_PLAN.md
 * section 4's exit gate says so directly, "a broker can watch it happen
 * without an account." The read endpoint behind it is unauthenticated for the
 * same reason `/v1/invitations/:token` is, and discloses nothing the holder
 * of the token does not already have.
 */
const PUBLIC_PREFIXES = ['/invite/', '/track/'] as const;

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Whether there is a person behind this session.
 *
 * A context rather than a hook that inspects Clerk, because the answer is
 * different in the two auth modes and a screen should not have to know which
 * one it is running under. `AuthGate` is the only thing that knows, so it is
 * the only thing that decides.
 */
const SignedInContext = createContext(false);

/** True when someone is signed in. Safe to call in either auth mode. */
export function useSignedIn(): boolean {
  return useContext(SignedInContext);
}

/** Re-reads the stored session when the picker writes one. */
export function useSession(): Session | null {
  const [session, setSession] = useState<Session | null>(() => readSession());
  useEffect(() => {
    const listener = () => setSession(readSession());
    window.addEventListener('haulq:session', listener);
    return () => window.removeEventListener('haulq:session', listener);
  }, []);
  return session;
}

export interface OrgSummary {
  id: string;
  name: string;
  role: string;
  /** Drives the payment gate in `Shell.tsx`. Anything but `'active'` means no confirmed subscription. */
  status: 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled';
  plan: 'carrier' | 'fleet' | null;
}

export function useOrgs() {
  return useQuery({
    queryKey: ['orgs'],
    queryFn: () => request<{ items: OrgSummary[] }>('/v1/orgs'),
  });
}

/**
 * Hands Clerk's token to the API client.
 *
 * A component rather than a call in `main.tsx` because `useAuth` only works
 * inside `ClerkProvider`. Renders nothing.
 */
function TokenBridge({ onReady }: { onReady: () => void }) {
  const { getToken, isLoaded } = useAuth();

  useEffect(() => {
    registerTokenGetter(() => getToken());
    if (isLoaded) onReady();
  }, [getToken, isLoaded, onReady]);

  return null;
}

/** Sign-in screen. Clerk's component, on HaulQ's page. */
function SignInScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-wash px-6">
      <div className="flex items-center gap-3">
        <Logo className="h-9" />
        <span className="hq-slash h-5 w-px" aria-hidden />
        <span className="field-label text-mute">Run every load</span>
      </div>
      <SignIn routing="hash" />
    </div>
  );
}

/**
 * Choosing a carrier after sign-in.
 *
 * A person can be signed in and belong to nothing — they have just registered,
 * or their invitation has not been accepted yet. That is a normal state, not an
 * error, so it gets a screen rather than a blank page.
 */
export function OrgPicker() {
  const queryClient = useQueryClient();
  const session = useSession();
  const orgs = useOrgs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createOrg = async () => {
    const name = window.prompt('What is the carrier called?', '');
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await request<{ org: OrgSummary }>('/v1/orgs', {
        body: { name, contactEmail: 'owner@example.com' },
      });
      writeSession({
        userId: session?.userId ?? 'clerk',
        orgId: res.org.id,
        orgName: res.org.name,
      });
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (orgs.isLoading) return <p className="p-8 text-mute">Loading your accounts…</p>;

  const items = orgs.data?.items ?? [];

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="mb-2 text-3xl">
        {items.length ? 'Which account?' : 'Set up your carrier'}
      </h1>
      <p className="mb-8 max-w-prose text-slate">
        {items.length
          ? 'You have access to more than one. Pick the one you are working in.'
          : 'You are signed in but not on any account yet. Create one, or ask whoever invited you to send the link again.'}
      </p>

      <div className="space-y-2">
        {items.map((org) => (
          <button
            key={org.id}
            className="flex w-full items-center justify-between border border-line bg-white px-5 py-4 text-left hover:border-ink"
            onClick={() => {
              writeSession({
                userId: session?.userId ?? 'clerk',
                orgId: org.id,
                orgName: org.name,
              });
              void queryClient.invalidateQueries();
            }}
          >
            <span className="text-lg">{org.name}</span>
            <span className="field-label text-mute">{org.role}</span>
          </button>
        ))}
      </div>

      <button
        className="hq-btn hq-btn-brand mt-6"
        onClick={createOrg}
        disabled={busy}
      >
        {busy ? 'Creating…' : 'Create a carrier account'}
      </button>

      {error && (
        <p className="mt-4 border-l-2 border-bad bg-bad-50 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Clerk's account menu, for the header. Renders nothing in dev mode.
 *
 * Carries a custom "Delete account" action into Clerk's own dropdown,
 * tucked behind a click on the avatar rather than sitting in the header as
 * standing text — a destructive, identity-level action earns that
 * restraint once real carriers are the ones seeing it. It lives here
 * rather than on the Profile screen because `AccountMenu` renders in every
 * one of `Shell`'s states (`OrgPicker`, `PlansScreen`, the real app), while
 * Profile is `children` and only reachable once an org is `active` — a
 * fresh or unpaid account could never reach it there.
 */
export function AccountMenu() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const orgs = useOrgs();
  if (!usingClerk) return null;

  // "Switch account" drops the cached org without signing out, and `Shell`
  // falls back to `OrgPicker`. It's hidden for a login with only one org,
  // because for that login the picker would just offer the same org again.
  const canSwitch = Boolean(session?.orgId) && (orgs.data?.items.length ?? 0) > 1;

  return (
    <UserButton afterSignOutUrl="/">
      <UserButton.MenuItems>
        {canSwitch ? (
          <UserButton.Action
            label="Switch account"
            labelIcon={
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="M3 5h9.5M10 2.5 12.5 5 10 7.5M13 11H3.5M6 8.5 3.5 11 6 13.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            onClick={() => {
              writeSession({ userId: session!.userId });
              void queryClient.invalidateQueries();
              void navigate({ to: '/' });
            }}
          />
        ) : null}
        <UserButton.Action
          label="Delete account"
          labelIcon={
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="M3 4h10M6.5 4V2.5h3V4M4 4l.6 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
          onClick={() => void navigate({ to: '/delete-account' })}
        />
      </UserButton.MenuItems>
    </UserButton>
  );
}

/**
 * Wraps the app in whichever auth the build is configured for.
 *
 * With no publishable key this is a pass-through, so `pnpm dev` works on a
 * laptop with no Clerk account — which is the whole reason the dev
 * authenticator exists.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [tokenReady, setTokenReady] = useState(false);
  const devSession = useSession();

  // Built without a Clerk key but pointed at a deployed API. Say so, rather
  // than letting every request 401 behind a working-looking interface.
  if (misconfigured) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="mb-3 text-3xl">This build has no sign-in configured</h1>
        <p className="mb-4 max-w-prose text-slate">
          It was built without <code className="num">VITE_CLERK_PUBLISHABLE_KEY</code>,
          so it falls back to development headers — and the API it is pointed at
          will refuse every one of them.
        </p>
        <p className="max-w-prose text-slate">
          Set that variable on the static site and <strong>rebuild</strong>.
          Vite inlines it at build time, so a restart will not pick it up.
        </p>
      </div>
    );
  }

  if (!usingClerk) {
    // Dev mode: the header session in localStorage is the only notion of
    // "signed in" there is.
    return (
      <SignedInContext.Provider value={devSession !== null}>
        {children}
      </SignedInContext.Provider>
    );
  }

  const publicPath = isPublicPath(window.location.pathname);

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} afterSignOutUrl="/">
      <SignedOut>
        {/* A public path renders inside the provider, not instead of it, so the
            screen can offer Clerk's own sign-in once the visitor has seen what
            they are being invited to. */}
        {publicPath ? (
          <SignedInContext.Provider value={false}>{children}</SignedInContext.Provider>
        ) : (
          <SignInScreen />
        )}
      </SignedOut>
      <SignedIn>
        <TokenBridge onReady={() => setTokenReady(true)} />
        {/* Nothing renders until the token getter is registered, or the first
            burst of queries fires unauthenticated and 401s. */}
        {tokenReady ? (
          <SignedInContext.Provider value={true}>{children}</SignedInContext.Provider>
        ) : (
          <p className="p-8 text-mute">Signing you in…</p>
        )}
      </SignedIn>
    </ClerkProvider>
  );
}
