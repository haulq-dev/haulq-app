/**
 * Sign-in, and — since this app is no longer driver-only — which carrier.
 *
 * Only ever mounted for the branch of `main.tsx` that isn't a check-in
 * link/token — see that file's note. `OrgGate` below is this app's version
 * of `apps/web`'s own `OrgPicker`: a driver accepting one invite still
 * lands straight in that one org with no picker shown (auto-selected, see
 * `OrgGate`'s own note), but an owner or dispatcher signing in directly —
 * never having gone through an invite-accept at all — needs somewhere to
 * get an `orgId` from, and a login that belongs to more than one carrier
 * needs an actual choice, not just a placeholder message.
 */

import { Browser } from '@capacitor/browser';
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
  useUser,
} from '@clerk/clerk-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { readSession, request, writeSession, type Session } from '../lib/api.ts';
import {
  CLERK_PUBLISHABLE_KEY,
  clerkFrontendApiHost,
  keyProblem,
  registerTokenGetter,
} from '../lib/auth.ts';
import { ErrorNote } from './ui.tsx';
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

/**
 * `SignInScreen`'s own copy of `APPEARANCE`, with Clerk's built-in "Don't
 * have an account? Sign up" footer link hidden — replaced with a button
 * that opens sign-up in the system browser via `Browser.open()`, same as
 * `DeleteAccountLink` below.
 *
 * An embedded `<SignUp/>` was tried first, but Cloudflare Turnstile (this
 * Clerk instance's bot-sign-up protection) runs sign-up through a
 * `challenges.cloudflare.com` iframe that talks to its parent via
 * `postMessage` — which fails inside this WebView (`postMessage` target
 * origin `challenges.cloudflare.com` vs. the WebView's own origin,
 * `https://localhost` on Android/iOS per `capacitor.config.ts`), surfacing
 * as "Authentication unsuccessful due to failed security validations" no
 * matter what's typed in. That's a WebView limitation, not something
 * `allowNavigation` or an appearance override can fix — Turnstile expects
 * a real browser origin. Sign-in has no such challenge and keeps working
 * embedded; only sign-up needs the real browser.
 */
const SIGN_IN_APPEARANCE = {
  elements: {
    ...APPEARANCE.elements,
    footerAction: { display: 'none' },
  },
} as const;

/** Clerk's hosted sign-up page for this instance, via the SDK rather than a hardcoded domain guess. */
function useSignUpUrl(): string {
  const clerk = useClerk();
  return clerk.buildSignUpUrl();
}

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

/** The accounts this login can act in — what `OrgGate` below reads to decide whether it needs to ask. */
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
  const signUpUrl = useSignUpUrl();

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-8 px-6">
      <Logo />
      <SignIn routing="hash" appearance={SIGN_IN_APPEARANCE} />
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          className="text-sm text-brand underline"
          onClick={() => void Browser.open({ url: signUpUrl })}
        >
          Don't have an account? Sign up
        </button>
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
 * Apple Guideline 5.1.1(v): an app that supports account creation must
 * also offer account deletion, in-app or via a link to a web page that
 * handles it. This is the link — the actual deletion (Clerk's own
 * self-service `user.delete()`) lives on `apps/web`'s `/delete-account`
 * page, which both apps' logins share since they're the same Clerk
 * identity. Every signed-in login gets this, not just owner/dispatcher —
 * unlike `ManageLinks` in `MyLoads.tsx`, this isn't role-gated, since
 * Apple's requirement applies to any account, driver included.
 *
 * Opened via `@capacitor/browser` rather than a plain link: this app's
 * `allowNavigation` (`capacitor.config.ts`) only allowlists Clerk's own
 * domains, not `app.haulq.ai`, and a destructive, identity-sensitive
 * action belongs in a real browser tab regardless.
 */
export function DeleteAccountLink() {
  return (
    <button
      type="button"
      className="text-sm text-brand underline"
      onClick={() => void Browser.open({ url: 'https://app.haulq.ai/delete-account' })}
    >
      Delete my account
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

/**
 * Which carrier this login is acting in, resolved before anything that
 * needs `X-HaulQ-Org-Id` renders (`request()` in `../lib/api.ts` reads it
 * off the session, same as web's client). Runs only outside the invite-
 * accept flow — see `AuthGate`'s own branching below for why: a fresh
 * invite acceptance is exactly the case where the login legitimately has
 * zero orgs yet, and `InviteAcceptScreen` is what establishes one.
 */
function OrgGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const orgs = useOrgs();

  // Already resolved (from a prior launch, or from the auto-select effect
  // below just having run) — the common path on every screen after the
  // first, so this returns immediately rather than waiting on `useOrgs()`
  // again.
  if (session?.orgId) return children;

  if (orgs.isLoading) {
    return <p className="p-8 text-mute">Loading your accounts…</p>;
  }

  const items = orgs.data?.items ?? [];

  if (items.length === 1) {
    return <AutoSelectOrg org={items[0]!}>{children}</AutoSelectOrg>;
  }

  if (items.length > 1) {
    return <OrgPicker orgs={items} />;
  }

  return <CreateOrgOrWait />;
}

interface CreatedOrg {
  id: string;
  name: string;
}

/**
 * A login with zero orgs — either a brand-new person creating their own
 * carrier (the self-serve path Apple's Guideline 3.2 review actually
 * checks for: can anyone become a customer, not just someone a dispatcher
 * already invited), or someone waiting on an invite/check-in code that
 * hasn't reached them yet. Both stay on this one screen — creating a
 * carrier is additive, not a replacement for the other two paths.
 *
 * `POST /v1/orgs` needs no prior org membership at all
 * (`authenticateUser`-only on `apps/api/src/routes/orgs.ts` — the same
 * endpoint `apps/web`'s own `createOrg` already calls), so nothing on the
 * backend had to change for this to work.
 */
function CreateOrgOrWait() {
  const { user } = useUser();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedOrg | null>(null);

  const create = useMutation({
    mutationFn: () =>
      request<{ org: CreatedOrg }>('/v1/orgs', {
        body: {
          name,
          // The signed-in person's own email, not a placeholder — this is
          // "where system mail goes" for the new carrier (see orgs'
          // schema comment), and Clerk already has a verified one on hand.
          contactEmail: user?.primaryEmailAddress?.emailAddress ?? '',
        },
      }),
    onSuccess: (res) => setCreated(res.org),
  });

  if (created) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="mb-2 text-2xl">{created.name} is set up</h1>
        <p className="text-slate">
          This app shows loads and lets a driver report progress — to add trucks, invite drivers,
          and start booking loads, sign in at <span className="num">app.haulq.ai</span> on a
          computer.
        </p>
        {/* Deliberately not automatic — `writeSession` here is what moves
            `OrgGate` on to `children`, and holding it behind a tap keeps
            this confirmation from flashing past unread. */}
        <button
          type="button"
          className="hq-btn hq-btn-brand mt-6"
          onClick={() =>
            // The creator of a brand-new org is always its owner —
            // `createOrg` (packages/db/src/repositories/orgs.ts) inserts
            // the membership with role: 'owner' directly, no other role
            // is possible here.
            writeSession({ userId: 'clerk', orgId: created.id, orgName: created.name, role: 'owner' })
          }
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-8 px-6 py-16">
      <div>
        <h1 className="mb-2 text-2xl">Set up your carrier</h1>
        <p className="mb-4 text-slate">New to HaulQ? Give your company a name to get started.</p>
        <input
          className="hq-input"
          placeholder="Company name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="hq-btn hq-btn-brand mt-4 w-full"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Creating…' : 'Create carrier account'}
        </button>
        <ErrorNote error={create.error} />
      </div>

      <div className="border-t border-line pt-6">
        <p className="text-sm text-slate">
          Already connected to a carrier on HaulQ? Ask whoever invited you to send the link again,
          or use a check-in code instead.
        </p>
        <button
          type="button"
          className="mt-2 text-sm text-brand underline"
          onClick={() => window.location.assign('/checkin')}
        >
          Have a check-in code instead?
        </button>
      </div>
    </div>
  );
}

/**
 * The overwhelmingly common case — one login, one carrier — lands straight
 * in it with no extra tap. Mirrors what `InviteAcceptScreen` already does
 * directly on accept; this is the same auto-selection generalized to a
 * login that never went through that screen at all (an owner signing in
 * directly, say).
 */
function AutoSelectOrg({ org, children }: { org: OrgSummary; children: ReactNode }) {
  useEffect(() => {
    writeSession({ userId: 'clerk', orgId: org.id, orgName: org.name, role: org.role });
  }, [org.id, org.name]);

  // `writeSession` dispatches `haulq:session`, which `useSession()` in the
  // parent `OrgGate` picks up on the next render — this brief placeholder
  // is only ever visible for that one render.
  return <p className="p-8 text-mute">Loading your account…</p>;
}

/** More than one carrier for this login — an actual choice, not a placeholder message. */
function OrgPicker({ orgs }: { orgs: OrgSummary[] }) {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="mb-6 text-2xl">Which account?</h1>
      <div className="space-y-2">
        {orgs.map((org) => (
          <button
            key={org.id}
            type="button"
            className="flex w-full items-center justify-between border border-line bg-white px-4 py-3 text-left"
            onClick={() => writeSession({ userId: 'clerk', orgId: org.id, orgName: org.name, role: org.role })}
          >
            <span>{org.name}</span>
            <span className="field-label text-mute">{org.role}</span>
          </button>
        ))}
      </div>
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
              first burst of queries fires unauthenticated and 401s. The
              provider wraps `OrgGate` itself, not just `children` — its
              own `useOrgs()` call needs `useSignedIn()` to already read
              true, or the query never fires. */}
          {tokenReady ? (
            <SignedInContext.Provider value={true}>
              {publicPath ? (
                // Invite-accept must not go through the org-gate — a
                // fresh invite acceptance is exactly the case where the
                // login legitimately has zero orgs yet, and
                // InviteAcceptScreen is what establishes one.
                children
              ) : (
                <OrgGate>{children}</OrgGate>
              )}
            </SignedInContext.Provider>
          ) : (
            <p className="p-8 text-mute">Signing you in…</p>
          )}
        </SignedIn>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
