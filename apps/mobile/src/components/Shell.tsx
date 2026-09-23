/**
 * The signed-in frame: the subscription gate, and the tab bar office roles get.
 *
 * MOBILE_PARITY_PLAN.md M0. This app used to be a driver companion with a
 * single list screen, so it had no navigation chrome at all. Owners,
 * dispatchers and accountants now get a bottom tab bar that grows one tab
 * per parity phase. Drivers keep the single-list experience they had, with
 * no tab bar. Everything a driver does is on that list and the load it
 * opens.
 *
 * **A tab appears only once its screen exists.** Apple rejects "coming soon"
 * placeholders (Guideline 2.1), so M1–M5 add their tab to `TABS` in the same
 * change that adds the screen. There is no disabled or teaser tab.
 */

import { Link, useRouterState } from '@tanstack/react-router';
import { canDispatch, isSubscriptionActive, type OrgSummary } from '@haulq/client';
import { useEffect, type ReactNode } from 'react';
import { writeSession } from '../lib/api.ts';
// AuthGate imports `SubscriptionGate` back from here. The cycle is safe
// because neither module touches the other's exports until render time.
import { DeleteAccountLink, SignOutLink, SwitchAccountLink, useOrgs, useSession } from './AuthGate.tsx';
import { ErrorNote } from './ui.tsx';

// ---------------------------------------------------------------------------
// Subscription gate
// ---------------------------------------------------------------------------

/**
 * Only a carrier whose subscription is `active` gets past here, the same
 * rule `apps/web`'s `Shell.tsx` applies, read from the same `GET /v1/orgs`.
 * Before this, the app never looked at `orgs.status`, so a cancelled or
 * never-paid carrier used it freely.
 *
 * **No purchase path, by design.** No plan names with prices, no "subscribe"
 * or "manage billing" button, no link to haulq.ai's pricing. That is what got
 * the app rejected under Guideline 3.1.1. See MOBILE_PARITY_PLAN.md section 2.
 * The screen says the account isn't active and nothing about where to pay.
 *
 * Deliberately not applied to check-in links (`Checkin.tsx`). Those are
 * outside this component entirely, anonymous, and the API does not gate
 * them either. A driver mid-load with an issued link keeps working.
 */
export function SubscriptionGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const orgs = useOrgs();
  const org = orgs.data?.items.find((o) => o.id === session?.orgId);

  // Keep the cached role in step with the server. It was written once, when
  // the org was picked, and a role change since then would otherwise show the
  // wrong tabs until the next sign-in.
  useEffect(() => {
    if (session && org && session.role !== org.role) {
      writeSession({ ...session, role: org.role });
    }
  }, [session, org]);

  // The org list loaded and this org is not in it: the membership is gone.
  // Drop just the org, so `OrgGate` resolves again from scratch.
  const orgGone = orgs.isSuccess && !org;
  useEffect(() => {
    if (orgGone && session) writeSession({ userId: session.userId });
  }, [orgGone, session]);

  if (orgs.isError) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-6 py-16">
        <ErrorNote error={orgs.error} />
        <button type="button" className="hq-btn hq-btn-ghost" onClick={() => void orgs.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  // Unknown must not read as paid. That covers loading, and the one render
  // after `orgGone` before the effect above clears the session.
  if (!org) return <p className="p-8 text-mute">Checking your account…</p>;

  if (!isSubscriptionActive(org.status)) {
    return <InactiveScreen org={org} onRecheck={() => void orgs.refetch()} rechecking={orgs.isFetching} />;
  }

  return children;
}

function InactiveScreen({
  org,
  onRecheck,
  rechecking,
}: {
  org: OrgSummary;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  return (
    <div className="mx-auto max-w-md space-y-4 px-6 py-16">
      <h1 className="text-2xl">Account not active</h1>
      <p className="text-slate">
        {org.name}'s HaulQ account isn't active right now.
        {org.role !== 'owner' && " Check with your carrier's owner."}
      </p>
      <button type="button" className="hq-btn hq-btn-ghost" disabled={rechecking} onClick={onRecheck}>
        {rechecking ? 'Checking…' : 'Check again'}
      </button>
      <div className="flex flex-wrap gap-4 pt-2">
        <SwitchAccountLink />
        <SignOutLink />
        <DeleteAccountLink />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

interface Tab {
  to: '/' | '/documents' | '/account';
  label: string;
  icon: (props: { active: boolean }) => ReactNode;
  isActive: (pathname: string) => boolean;
}

/** In display order. See the module note: a tab lands with its screen, never before. */
const TABS: readonly Tab[] = [
  {
    to: '/',
    label: 'Loads',
    icon: LoadsIcon,
    isActive: (p) => p === '/' || p.startsWith('/loads'),
  },
  {
    to: '/documents',
    label: 'Documents',
    icon: DocumentsIcon,
    isActive: (p) => p.startsWith('/documents'),
  },
  {
    to: '/account',
    label: 'Account',
    icon: AccountIcon,
    isActive: (p) => p.startsWith('/account'),
  },
];

/**
 * Office roles get tabs; a driver does not. Accountants count as office
 * because Pay (M3) is theirs, even though `canDispatch` is false for them.
 */
export function showsTabBar(role: string | undefined): boolean {
  return canDispatch(role) || role === 'accountant';
}

export function TabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto flex max-w-md">
        {TABS.map((tab) => {
          const active = tab.isActive(pathname);
          return (
            <li key={tab.to} className="flex-1">
              <Link
                to={tab.to}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-semibold ${
                  active ? 'text-brand' : 'text-mute'
                }`}
              >
                {tab.icon({ active })}
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Space for the fixed tab bar, so the last card on a long list is not
 * hidden behind it. `body` already pads the home-indicator inset (see
 * styles.css), so this only adds the bar's own height.
 */
export function TabBarSpacer() {
  return <div aria-hidden className="h-[3.25rem]" />;
}

function LoadsIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} aria-hidden>
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" strokeLinejoin="round" />
      <circle cx="7" cy="17.5" r="1.5" />
      <circle cx="17" cy="17.5" r="1.5" />
    </svg>
  );
}

function DocumentsIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} aria-hidden>
      <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <path d="M14 3v4h4M9 12h6M9 16h6" strokeLinecap="round" />
    </svg>
  );
}

function AccountIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} aria-hidden>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c1.2-3.2 3.9-5 7-5s5.8 1.8 7 5" strokeLinecap="round" />
    </svg>
  );
}
