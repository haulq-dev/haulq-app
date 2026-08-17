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
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './components/Shell.tsx';
import { ImportScreen } from './routes/Import.tsx';
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

const rootRoute = createRootRoute({
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
});

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

const routeTree = rootRoute.addChildren([
  indexRoute,
  profileRoute,
  trucksRoute,
  importRoute,
  timelineRoute,
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
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
