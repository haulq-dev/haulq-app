/**
 * The frame: brand bar, navigation, and whichever sign-in the build uses.
 *
 * With a Clerk publishable key the dev bar disappears entirely and Clerk's
 * account menu takes its place. Without one it stays — striped, labelled, and
 * impossible to mistake for product chrome, because the worst outcome would be
 * someone demoing this and taking it for a real account switcher.
 */

import { Link, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { request, writeSession } from '../lib/api.ts';
import { usingClerk } from '../lib/auth.ts';
import { AccountMenu, OrgPicker, useOrgs, useSession } from './AuthGate.tsx';
import { Logo } from './Logo.tsx';

const NAV = [
  { to: '/', label: 'Setup' },
  { to: '/profile', label: 'Carrier' },
  { to: '/trucks', label: 'Trucks' },
  { to: '/drivers', label: 'Drivers' },
  { to: '/members', label: 'People' },
  { to: '/import', label: 'Import' },
  { to: '/timeline', label: 'Activity' },
] as const;

function DevSessionBar() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgs = useOrgs();

  /**
   * Start a session as a brand-new person.
   *
   * There is no "create user" endpoint — users arrive from Clerk. So this mints
   * a uuid locally and lets the dev authenticator vouch for it; the API creates
   * the row on first sight, exactly as it will when Clerk redirects a real
   * sign-up before the webhook lands.
   */
  const startFresh = () => {
    writeSession({ userId: crypto.randomUUID() });
    void queryClient.invalidateQueries();
  };

  const signUpCarrier = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const name = window.prompt('Carrier name', 'Prairie Freight LLC');
      if (!name) return;
      const res = await request<{ org: { id: string; name: string } }>('/v1/orgs', {
        body: { name, contactEmail: 'owner@example.com' },
      });
      writeSession({ ...session, orgId: res.org.id, orgName: res.org.name });
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hq-stripes border-b border-line bg-wash">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-2">
        <span className="field-label text-brand">Dev session</span>

        {!session ? (
          <button className="hq-btn hq-btn-ghost" onClick={startFresh}>
            Start as a new person
          </button>
        ) : (
          <>
            <span className="num text-xs text-mute">
              {session.userId.slice(0, 8)}
            </span>

            {orgs.data && orgs.data.items.length > 0 ? (
              <select
                className="hq-input w-auto py-1 text-sm"
                value={session.orgId ?? ''}
                onChange={(e) => {
                  const picked = orgs.data.items.find((o) => o.id === e.target.value);
                  writeSession({
                    userId: session.userId,
                    orgId: picked?.id,
                    orgName: picked?.name,
                  });
                  void queryClient.invalidateQueries();
                }}
              >
                <option value="">No carrier selected</option>
                {orgs.data.items.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} — {o.role}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-mute">No carriers yet</span>
            )}

            <button className="hq-btn hq-btn-ghost" onClick={signUpCarrier} disabled={busy}>
              {busy ? 'Creating…' : 'New carrier'}
            </button>
            <button
              className="hq-btn hq-btn-ghost"
              onClick={() => {
                writeSession(null);
                void queryClient.invalidateQueries();
              }}
            >
              Sign out
            </button>
          </>
        )}

        {error && <span className="text-xs text-bad">{error}</span>}

        {/* `ml-auto` pushes this to the right on a wide row, but on a narrow one
            it fights flex-wrap and forces the bar wider than the viewport. The
            basis-full below md puts it on its own line instead. */}
        <span className="basis-full text-xs text-mute md:ml-auto md:basis-auto">
          Header-based auth. Clerk replaces this — see docs/clerk-setup.md.
        </span>
      </div>
    </div>
  );
}

/** The three-bar / cross toggle. Inline rather than a dependency for two icons. */
function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      aria-hidden
    >
      {open ? (
        <path d="M5 5l14 14M19 5L5 19" />
      ) : (
        <path d="M3 6h18M3 12h18M3 18h18" />
      )}
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);

  /**
   * Close on navigation.
   *
   * TanStack Router keeps the Shell mounted across a route change, so without
   * this the drawer stays open over the screen it just navigated to — which
   * reads as a broken tap on a phone.
   */
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const navLink = (item: (typeof NAV)[number], block: boolean) => {
    const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
    return (
      <Link
        key={item.to}
        to={item.to}
        aria-current={active ? 'page' : undefined}
        className={
          block
            ? `field-label border-l-2 px-6 py-3 ${
                active ? 'border-brand text-ink' : 'border-transparent text-mute'
              }`
            : `field-label px-3 py-2 ${
                active
                  ? 'border-b-2 border-brand text-ink'
                  : 'border-b-2 border-transparent text-mute hover:text-ink'
              }`
        }
      >
        {item.label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-white">
      {!usingClerk && <DevSessionBar />}

      <header className="border-b border-line">
        {/* `min-w-0` on the brand block is what actually stops the header
            stretching: a flex child defaults to min-width:auto, so a long
            carrier name refuses to shrink and pushes the row past the
            viewport, which is what produced the horizontal scroll. */}
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6 sm:py-4 md:gap-6">
          <div className="flex min-w-0 items-center gap-2">
            <Logo className="h-6 shrink-0 sm:h-7" />
            <span className="hq-slash h-4 w-px shrink-0" aria-hidden />
            <span className="field-label truncate text-mute">
              {session?.orgName ?? 'no carrier'}
            </span>
          </div>

          {/* Wide screens: the links inline. */}
          <nav className="hidden gap-1 md:flex">
            {NAV.map((item) => navLink(item, false))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <AccountMenu />

            <button
              type="button"
              className="hq-btn hq-btn-ghost px-2 md:hidden"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="hq-mobile-nav"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MenuIcon open={menuOpen} />
            </button>
          </div>
        </div>

        {/* Narrow screens: the same links, stacked. Rendered in the document
            rather than floated over it, so it pushes content down instead of
            covering it — no overlay to trap a tap behind. */}
        {menuOpen && (
          <nav
            id="hq-mobile-nav"
            className="flex flex-col border-t border-line py-2 md:hidden"
          >
            {NAV.map((item) => navLink(item, true))}
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {session?.orgId ? children : <OrgPicker />}
      </main>
    </div>
  );
}
