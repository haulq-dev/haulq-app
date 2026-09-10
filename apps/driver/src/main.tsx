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
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
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

/**
 * Catches what `ErrorBoundary` cannot: an error thrown outside React's
 * render cycle. This turned out to be the actual shape of the real bug —
 * Clerk's provider renders an empty-but-successful frame immediately, then
 * fails *asynchronously* fetching its own JS bundle, as a rejected promise
 * with nothing downstream to catch it. `ErrorBoundary` only sees errors
 * thrown during render, so it never saw this one; a white screen was the
 * result. Reproduced locally with a malformed key before this existed —
 * see the commit this landed in for how.
 *
 * An overlay appended to `<body>`, not a replacement of `#root`'s content —
 * React still owns that node, and this net was written for exactly the
 * case where nobody can be sure what state React's tree is actually in.
 * `id`-guarded so a second error while debugging doesn't stack duplicates.
 */
function showFatalError(error: unknown): void {
  if (document.getElementById('haulq-fatal-error')) return;

  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const overlay = document.createElement('div');
  overlay.id = 'haulq-fatal-error';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#fff;overflow:auto;font-family:sans-serif';
  overlay.innerHTML = `<div style="max-width:28rem;margin:0 auto;padding:4rem 1.5rem">
    <h1 style="font-size:1.25rem;color:#b91c1c">Something went wrong</h1>
    <p style="font-size:0.875rem;color:#475569">${escapeHtml(message)}</p>
  </div>`;
  document.body.appendChild(overlay);
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

window.addEventListener('error', (event) => showFatalError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showFatalError(event.reason));

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
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
    </ErrorBoundary>
  </StrictMode>,
);
