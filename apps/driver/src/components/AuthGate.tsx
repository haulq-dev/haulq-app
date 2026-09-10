/**
 * Sign-in for a driver's own account.
 *
 * Only ever mounted for the branch of `main.tsx` that isn't a check-in
 * link/token — see that file's note. There is no "which carrier" picker
 * here the way `apps/web`'s `AuthGate` has one: a driver invited to one
 * carrier belongs to exactly one org in the common case, so the session's
 * `orgId` is written straight from the invite-accept response. If a login
 * ever does belong to more than one, `useOrgs()` below is what a future
 * picker would read — v1 just shows a plain message instead of building
 * that screen before anyone needs it.
 */

import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth,
  useClerk,
} from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { readSession, request, type Session } from '../lib/api.ts';
import {
  CLERK_PUBLISHABLE_KEY,
  clerkFrontendApiHost,
  keyProblem,
  registerTokenGetter,
} from '../lib/auth.ts';
import { Logo } from './Logo.tsx';

/**
 * Paths that render for a signed-out visitor — same reasoning as
 * `apps/web`'s copy of this constant. An invite link is opened by someone
 * who has no HaulQ account yet; showing a bare sign-in wall with no context
 * is how the invitation gets ignored. `InviteAccept.tsx` does its own
 * `useSignedIn()`-based branching once rendered here, exactly like web's
 * `InviteScreen` does.
 */
const PUBLIC_PREFIXES = ['/invite/'] as const;

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Hides Clerk's social sign-in buttons (Google, today) from this app's
 * `<SignIn/>` only — social connections are configured instance-wide in
 * the Clerk dashboard, shared with `apps/web`, so there's no per-app
 * toggle to disable Google there without also breaking it for web. This
 * hides the button instead of disabling the strategy: Google's OAuth
 * policy refuses to complete sign-in from any embedded WebView regardless
 * (see `capacitor.config.ts`'s note), so the button was previously a dead
 * end — a spinner, then nothing. `dividerRow` goes with it so there's no
 * orphaned "or" divider sitting above the email field with nothing above it.
 */
const APPEARANCE = {
  elements: {
    socialButtonsBlockButton: { display: 'none' },
    socialButtonsIconButton: { display: 'none' },
    dividerRow: { display: 'none' },
  },
} as const;

const SignedInContext = createContext(false);

/** True once someone is signed in and their token is ready to attach to requests. */
export function useSignedIn(): boolean {
  return useContext(SignedInContext);
}

/** Re-reads the stored session whenever `writeSession` writes one. */
export function useSession(): Session | null {
  const [session, setSession] = useState<Session | null>(() => readSession());
  useEffect(() => {
    const listener = () => setSession(readSession());
    window.addEventListener('haulq:session', listener);
    return () => window.removeEventListener('haulq:session', listener);
  }, []);
  return session;
}

interface OrgSummary {
  id: string;
  name: string;
  role: string;
}

/** The accounts this login can act in — see the module note on why v1 has no picker built against it yet. */
export function useOrgs() {
  return useQuery({
    queryKey: ['orgs'],
    queryFn: () => request<{ items: OrgSummary[] }>('/v1/orgs'),
    enabled: useSignedIn(),
  });
}

/** Hands Clerk's token to the plain-function API client. Renders nothing. */
function TokenBridge({ onReady }: { onReady: () => void }) {
  const { getToken, isLoaded } = useAuth();

  useEffect(() => {
    registerTokenGetter(() => getToken());
    if (isLoaded) onReady();
  }, [getToken, isLoaded, onReady]);

  return null;
}

function SignInScreen() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-8 px-6">
      <Logo />
      <SignIn routing="hash" />
      {/* A full navigation, not client-side state — `main.tsx` decides
          `CheckinScreen` vs. this screen once, from the URL, at mount. */}
      <button
        type="button"
        className="text-sm text-brand underline"
        onClick={() => window.location.assign('/checkin')}
      >
        Have a check-in code instead?
      </button>
    </div>
  );
}

/** Plain-text sign-out, for whatever screen wants one — no header/nav chrome exists yet to hang a `UserButton` off of. */
export function SignOutLink() {
  const { signOut } = useClerk();
  return (
    <button type="button" className="text-sm text-brand underline" onClick={() => void signOut()}>
      Sign out
    </button>
  );
}

/**
 * A build with no usable `VITE_CLERK_PUBLISHABLE_KEY` — a broken build, not
 * a supported mode. Unlike `apps/web`, this app has one deploy target and
 * no dev-header fallback to fall back to, so the failure is stated plainly
 * — and specifically, via `keyProblem()` — rather than either silently
 * 401ing behind a working-looking screen, or reaching `ClerkProvider` at
 * all and letting it fail with a generic "Publishable key not valid" that
 * doesn't say which of several very different problems this actually is.
 */
function MisconfiguredScreen({ problem }: { problem: string }) {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="mb-2 text-2xl">This build has no working sign-in</h1>
      <p className="text-slate">{problem}</p>
    </div>
  );
}

/**
 * The gap `ErrorBoundary`/`main.tsx`'s global handlers cannot see: neither
 * `<SignedIn>` nor `<SignedOut>` renders anything until Clerk's SDK finishes
 * initializing, and a slow or hung load is not an error — nothing throws,
 * nothing rejects, there is just nothing on screen. This was very likely
 * the actual shape of a white screen that survived those two safety nets.
 * `<ClerkLoading>`/`<ClerkFailed>` are Clerk's own components for exactly
 * this window; a stuck-detection timer sits on top because "still loading"
 * forever, with nothing to act on, is barely better than blank.
 */
function LoadingScreen() {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setStuck(true), 6000);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <p className="text-mute">Loading…</p>
      {stuck && (
        <div className="mt-4 space-y-3 text-left">
          <p className="text-sm text-slate">
            Still trying to reach sign-in ({clerkFrontendApiHost() ?? 'unknown host'}) after 6
            seconds. This usually means a network or configuration problem, not something that
            resolves on its own.
          </p>
          <button className="hq-btn hq-btn-ghost" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    </div>
  );
}

function FailedScreen() {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="mb-2 text-xl text-bad">Sign-in failed to load</h1>
      <p className="text-sm text-slate">
        Could not reach {clerkFrontendApiHost() ?? 'the sign-in service'}. Check the device's
        network connection, or this may mean that domain isn't allowlisted in the app's
        navigation config (capacitor.config.ts's allowNavigation) or isn't set up correctly in
        the Clerk dashboard yet.
      </p>
      <button className="hq-btn hq-btn-ghost mt-4" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [tokenReady, setTokenReady] = useState(false);

  const problem = keyProblem();
  if (problem) return <MisconfiguredScreen problem={problem} />;

  const publicPath = isPublicPath(window.location.pathname);

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} afterSignOutUrl="/" appearance={APPEARANCE}>
      <ClerkLoading>
        <LoadingScreen />
      </ClerkLoading>
      <ClerkFailed>
        <FailedScreen />
      </ClerkFailed>
      <ClerkLoaded>
        <SignedOut>
          {/* A public path renders the router itself, not instead of it, so
              the route component can offer sign-in once it has shown what the
              visitor is being invited to — same as web's own note here. */}
          {publicPath ? (
            <SignedInContext.Provider value={false}>{children}</SignedInContext.Provider>
          ) : (
            <SignInScreen />
          )}
        </SignedOut>
        <SignedIn>
          <TokenBridge onReady={() => setTokenReady(true)} />
          {/* Nothing renders until the token getter is registered, or the
              first burst of queries fires unauthenticated and 401s. */}
          {tokenReady ? (
            <SignedInContext.Provider value={true}>{children}</SignedInContext.Provider>
          ) : (
            <p className="p-8 text-mute">Signing you in…</p>
          )}
        </SignedIn>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
