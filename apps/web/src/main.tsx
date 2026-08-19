/**
 * App shell.
 *
 * Code-based routes rather than TanStack's file-based ones: file routing needs
 * a codegen step in the build, and six screens do not justify a generated file
 * that has to stay in sync.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './components/AuthGate.tsx';
import { Shell } from './components/Shell.tsx';
import { DriversScreen } from './routes/Drivers.tsx';
import { ImportScreen } from './routes/Import.tsx';
import { InviteScreen } from './routes/Invite.tsx';
import { MembersScreen } from './routes/Members.tsx';
import { OnboardingScreen } from './routes/Onboarding.tsx';
import { ProfileScreen } from './routes/Profile.tsx';
import { TimelineScreen } from './routes/Timeline.tsx';
import { TrucksScreen } from './routes/Trucks.tsx';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cab connectivity is intermittent. A phone that just regained signal
      // should show cached data rather than a burst of requests and a spinner.
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * The frame, except where there is no frame yet.
 *
 * `Shell` is chrome for someone already inside a carrier — it shows the nav and
 * falls back to the account picker when no carrier is selected. An invitation is
 * opened by someone who is in neither state, so wrapping it would hand them the
 * picker instead of the invitation they clicked.
 *
 * Kept as a pathname check rather than a second route tree: one screen does not
 * justify a layout hierarchy, and this is the only place that has to know.
 */
const CHROMELESS = ['/invite/'];

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (CHROMELESS.some((p) => pathname.startsWith(p))) return <Outlet />;
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

// Declared one by one rather than mapped over an array: TanStack infers the
// route tree's types from these literals, and a `.map()` widens `path` to
// `string`, which silently turns every typed `<Link to>` into an error.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OnboardingScreen,
});
const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile',
  component: ProfileScreen,
});
const trucksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trucks',
  component: TrucksScreen,
});
const driversRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/drivers',
  component: DriversScreen,
});
const membersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/members',
  component: MembersScreen,
});
const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/import',
  component: ImportScreen,
});
const timelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/timeline',
  component: TimelineScreen,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InviteScreen,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  profileRoute,
  trucksRoute,
  driversRoute,
  membersRoute,
  importRoute,
  timelineRoute,
  inviteRoute,
]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* AuthGate is outside the router: with Clerk configured, an
          unauthenticated visitor sees the sign-in screen rather than a route. */}
      <AuthGate>
        <RouterProvider router={router} />
      </AuthGate>
    </QueryClientProvider>
  </StrictMode>,
);
