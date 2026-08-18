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
import { useState, type ReactNode } from 'react';
import { request, writeSession } from '../lib/api.ts';
import { usingClerk } from '../lib/auth.ts';
import { AccountMenu, OrgPicker, useOrgs, useSession } from './AuthGate.tsx';
import { Logo } from './Logo.tsx';

const NAV = [
  { to: '/', label: 'Setup' },
  { to: '/profile', label: 'Carrier' },
  { to: '/trucks', label: 'Trucks' },
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

        <span className="ml-auto text-xs text-mute">
          Header-based auth. Clerk replaces this — see docs/clerk-setup.md.
        </span>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-screen bg-white">
      {!usingClerk && <DevSessionBar />}

      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <div className="flex items-center gap-2">
            <Logo className="h-7" />
            <span className="hq-slash h-4 w-px" aria-hidden />
            <span className="field-label text-mute">
              {session?.orgName ?? 'no carrier'}
            </span>
          </div>

          <nav className="flex gap-1">
            {NAV.map((item) => {
              const active =
                item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`field-label px-3 py-2 ${
                    active
                      ? 'border-b-2 border-brand text-ink'
                      : 'border-b-2 border-transparent text-mute hover:text-ink'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto">
            <AccountMenu />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {session?.orgId ? children : <OrgPicker />}
      </main>
    </div>
  );
}
