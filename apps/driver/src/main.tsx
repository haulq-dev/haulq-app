/**
 * App shell.
 *
 * Two branches, decided once at mount from `isCheckinRoute()`:
 *
 *  - **A check-in link or a stored token** — `CheckinScreen`, unchanged,
 *    exactly as it worked when this was the whole app. Deliberately kept
 *    reachable with no sign-in at all, for a driver not yet linked to an
 *    account (see that file's own module note).
 *  - **Everything else** — `AuthGate` wrapping a small router: accepting an
 *    invite, a driver's own assigned loads, and one load's stop milestones.
 *    Code-based routes, same reasoning `apps/web/src/main.tsx` gives: three
 *    screens do not justify a codegen step.
 */

import { App as CapacitorApp } from '@capacitor/app';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './components/AuthGate.tsx';
import { CheckinScreen, isCheckinRoute } from './routes/Checkin.tsx';
import { InviteAcceptScreen } from './routes/Invite.tsx';
import { LoadDetailScreen } from './routes/LoadDetail.tsx';
import { MyLoadsScreen } from './routes/MyLoads.tsx';
import './styles.css';

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

const rootRoute = createRootRoute();
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: MyLoadsScreen });
const loadDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/loads/$loadId',
  component: LoadDetailScreen,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InviteAcceptScreen,
});

const routeTree = rootRoute.addChildren([indexRoute, loadDetailRoute, inviteRoute]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

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
        // AuthGate is outside the router — see its own module note on the
        // one path (`/invite/`) it still renders the router for while
        // signed out.
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      )}
    </QueryClientProvider>
  </StrictMode>,
);
