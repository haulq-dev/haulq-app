/**
 * App shell.
 *
 * Two branches, decided once at mount from `isCheckinRoute()`, not a router:
 *
 *  - **A check-in link or a stored token** — `CheckinScreen`, unchanged,
 *    exactly as it worked when this was the whole app. Deliberately kept
 *    reachable with no sign-in at all, for a driver not yet linked to an
 *    account (see that file's own module note).
 *  - **Everything else** — `AuthGate`, a driver's own signed-in account.
 *    Real screens (their assigned loads, a stop's milestones) are still
 *    being built on top of this foundation; `LandingStub` below is a
 *    placeholder for exactly that gap, not a finished screen.
 *
 * `@tanstack/react-router` is a dependency already, ready for when that
 * signed-in side grows past one screen — not wired in yet, same reasoning
 * this file used to give for having no router at all: a router is a guess
 * about how many screens there will be, and right now there is one on each
 * side of this branch.
 */

import { App as CapacitorApp } from '@capacitor/app';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate, SignOutLink } from './components/AuthGate.tsx';
import { CheckinScreen, isCheckinRoute } from './routes/Checkin.tsx';
import './styles.css';

/** Stands in for the real signed-in screens (assigned loads, milestones) until those land. */
function LandingStub() {
  return (
    <div className="mx-auto max-w-md space-y-4 px-6 py-16 text-center">
      <p className="text-slate">You&apos;re signed in. Your loads will show up here.</p>
      <SignOutLink />
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Same reasoning apps/web's client carries: cab connectivity is
      // intermittent, and a driver who just regained signal should see
      // cached data rather than a burst of requests and a spinner.
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * A deep link opened while the app was already running (or cold-started
 * into one). Native registration for a custom scheme or a Universal/App
 * Link still has to happen in `ios/`/`android/` — this only handles the
 * event once the OS actually hands it to the app. A full navigation rather
 * than route-state plumbing: launching from a link is effectively a cold
 * start anyway, and this keeps `main.tsx` the only place that has to know
 * `CapacitorApp` exists.
 */
CapacitorApp.addListener('appUrlOpen', ({ url }) => {
  try {
    const parsed = new URL(url);
    window.location.href = parsed.pathname + parsed.search;
  } catch {
    // Not a URL Capacitor's own docs promise it always is, but a malformed
    // one should not crash the app that is already running.
  }
});

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isCheckinRoute() ? (
        <CheckinScreen />
      ) : (
        <AuthGate>
          <LandingStub />
        </AuthGate>
      )}
    </QueryClientProvider>
  </StrictMode>,
);
