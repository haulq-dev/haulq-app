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
 *    invite, the loads list, one load's stop milestones, the owner shortcuts
 *    and the Account tab. Office roles get a tab bar, drivers don't (see
 *    `components/Shell.tsx`). Code-based routes, same reasoning
 *    `apps/web/src/main.tsx` gives. Revisit file-based routing once the
 *    MOBILE_PARITY_PLAN.md phases push this past a dozen screens.
 */

import { App as CapacitorApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { ApiClientProvider, inAppPath, isSubscriptionInactive, pushOrgId, pushTapPath, queryKeys, type OrgSummary } from '@haulq/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate, useSession } from './components/AuthGate.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { showsTabBar, TabBar, TabBarSpacer } from './components/Shell.tsx';
import { apiClient, readSession, writeSession } from './lib/api.ts';
import { listenForPush, refreshPushRegistration } from './lib/push.ts';
import { AccountScreen } from './routes/Account.tsx';
import { AutopilotScreen } from './routes/autopilot/AutopilotScreen.tsx';
import { MessageScreen } from './routes/autopilot/MessageScreen.tsx';
import { DocumentScreen } from './routes/documents/DocumentScreen.tsx';
import { DocumentsScreen } from './routes/documents/DocumentsScreen.tsx';
import { CheckinScreen, isCheckinRoute } from './routes/Checkin.tsx';
import { CreateLoadScreen } from './routes/CreateLoad.tsx';
import { InviteAcceptScreen } from './routes/Invite.tsx';
import { LoadRoute } from './routes/load/LoadScreen.tsx';
import { HomeRoute } from './routes/Home.tsx';
import { ActivityScreen } from './routes/more/ActivityScreen.tsx';
import { CarrierScreen } from './routes/more/CarrierScreen.tsx';
import { InsightsScreen } from './routes/more/InsightsScreen.tsx';
import { IntegrationsScreen } from './routes/more/IntegrationsScreen.tsx';
import { NotificationsScreen } from './routes/more/NotificationsScreen.tsx';
import { ProposalScreen } from './routes/proposals/ProposalScreen.tsx';
import { ProposalsScreen } from './routes/proposals/ProposalsScreen.tsx';
import { DriverScreen, NewDriverScreen } from './routes/fleet/DriverScreen.tsx';
import { DriversScreen } from './routes/fleet/DriversScreen.tsx';
import { PeopleScreen } from './routes/fleet/PeopleScreen.tsx';
import { NewTruckScreen, TruckScreen } from './routes/fleet/TruckScreen.tsx';
import { TrucksScreen } from './routes/fleet/TrucksScreen.tsx';
import { FactoringScreen } from './routes/pay/FactoringScreen.tsx';
import { InvoiceScreen } from './routes/pay/InvoiceScreen.tsx';
import { NewInvoiceScreen } from './routes/pay/NewInvoiceScreen.tsx';
import { PayScreen } from './routes/pay/PayScreen.tsx';
import './styles.css';

const queryClient: QueryClient = new QueryClient({
  /**
   * The API's own paywall (`REQUIRE_ACTIVE_SUBSCRIPTION`) can refuse
   * mid-session, when a subscription lapses while the app is open. Refetching
   * the org list lets `SubscriptionGate` see the new status and swap the
   * whole app for its "not active" screen, instead of every screen showing
   * the same refusal one query at a time.
   */
  queryCache: new QueryCache({
    onError: (error) => {
      if (isSubscriptionInactive(error)) void queryClient.invalidateQueries({ queryKey: queryKeys.orgs });
    },
  }),
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
 * Clears the status bar/notch for every routed screen, in one place.
 * `Checkin.tsx` owns its own inset via `.hq-header-safe` on its header bar
 * — it's mounted outside this router entirely — but nothing else did,
 * which is exactly why "Your loads"'s heading rendered under the status
 * bar on a real device: none of MyLoads/LoadDetail/Invite's own padding
 * accounts for a dynamic inset that varies by device. Fixed once here
 * rather than patched into each screen's own wrapper `div`.
 */
function RootLayout() {
  // The tab bar is for office roles only (see `Shell.tsx`). A signed-out
  // visitor on an invite link has no session, so no role and no tab bar.
  const role = useSession()?.role;
  const tabs = showsTabBar(role);
  return (
    <div className="pt-[env(safe-area-inset-top)]">
      <Outlet />
      {tabs && (
        <>
          <TabBarSpacer />
          <TabBar role={role} />
        </>
      )}
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomeRoute });
const loadDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/loads/$loadId',
  component: LoadRoute,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InviteAcceptScreen,
});
const trucksRoute = createRoute({ getParentRoute: () => rootRoute, path: '/trucks', component: TrucksScreen });
const newTruckRoute = createRoute({ getParentRoute: () => rootRoute, path: '/trucks/new', component: NewTruckScreen });
const truckRoute = createRoute({ getParentRoute: () => rootRoute, path: '/trucks/$truckId', component: TruckScreen });
const driversRoute = createRoute({ getParentRoute: () => rootRoute, path: '/drivers', component: DriversScreen });
const newDriverRoute = createRoute({ getParentRoute: () => rootRoute, path: '/drivers/new', component: NewDriverScreen });
const driverRoute = createRoute({ getParentRoute: () => rootRoute, path: '/drivers/$driverId', component: DriverScreen });
const insightsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/insights', component: InsightsScreen });
const activityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/activity', component: ActivityScreen });
const proposalsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/proposals', component: ProposalsScreen });
const proposalRoute = createRoute({ getParentRoute: () => rootRoute, path: '/proposals/$proposalId', component: ProposalScreen });
const notificationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notifications', component: NotificationsScreen });
const integrationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/integrations', component: IntegrationsScreen });
const carrierRoute = createRoute({ getParentRoute: () => rootRoute, path: '/carrier', component: CarrierScreen });
const peopleRoute = createRoute({ getParentRoute: () => rootRoute, path: '/people', component: PeopleScreen });
const createLoadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/loads/new',
  component: CreateLoadScreen,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  component: AccountScreen,
});

const documentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/documents',
  component: DocumentsScreen,
});
const documentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/documents/$documentId',
  component: DocumentScreen,
});

const autopilotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/autopilot',
  component: AutopilotScreen,
});
const autopilotMessageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/autopilot/$messageId',
  component: MessageScreen,
});

const payRoute = createRoute({ getParentRoute: () => rootRoute, path: '/pay', component: PayScreen });
const newInvoiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pay/new',
  component: NewInvoiceScreen,
  // Opened from a delivered load's screen, the load comes preselected.
  validateSearch: (search: Record<string, unknown>): { loadId?: string } =>
    typeof search['loadId'] === 'string' ? { loadId: search['loadId'] } : {},
});
const factoringRoute = createRoute({ getParentRoute: () => rootRoute, path: '/pay/factoring', component: FactoringScreen });
const invoiceRoute = createRoute({ getParentRoute: () => rootRoute, path: '/pay/$invoiceId', component: InvoiceScreen });

const routeTree = rootRoute.addChildren([
  accountRoute,
  autopilotRoute,
  autopilotMessageRoute,
  documentsRoute,
  documentRoute,
  payRoute,
  newInvoiceRoute,
  factoringRoute,
  invoiceRoute,
  indexRoute,
  loadDetailRoute,
  inviteRoute,
  trucksRoute,
  newTruckRoute,
  truckRoute,
  driversRoute,
  newDriverRoute,
  driverRoute,
  peopleRoute,
  insightsRoute,
  activityRoute,
  carrierRoute,
  integrationsRoute,
  notificationsRoute,
  proposalsRoute,
  proposalRoute,
  createLoadRoute,
]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/**
 * Coming back to the app looks again at what Autopilot wrote. There is no push
 * yet, so this and the open screen's own timer are how a message that arrived
 * while the phone was in a pocket shows up: the tab's count and the inbox.
 */
CapacitorApp.addListener('appStateChange', ({ isActive }) => {
  if (isActive) void queryClient.invalidateQueries({ queryKey: queryKeys.outbound });
});

/**
 * Query keys aren't org-scoped (`['loads', …]`, not `[orgId, 'loads', …]`),
 * so a cached list from the previous carrier would otherwise keep rendering
 * after "Switch account" or the picker writes a new `orgId` — and with
 * `staleTime` above, wouldn't even refetch for a while. One listener here
 * covers every writer (`OrgGate`, `SwitchAccountLink`, sign-out, invite
 * accept) instead of each remembering to do it. The org list itself survives
 * a switch — it's per-login, not per-org, and the picker needs it — but not a
 * sign-out, since the next login may be someone else.
 */
let lastOrgId = readSession()?.orgId;
window.addEventListener('haulq:session', () => {
  const session = readSession();
  // Signed in (or switched): make sure this phone is registered to them.
  if (session?.userId) void refreshPushRegistration().catch(() => {});
  if (!session) {
    lastOrgId = undefined;
    queryClient.clear();
    return;
  }
  if (session.orgId === lastOrgId) return;
  const switched = lastOrgId !== undefined;
  lastOrgId = session.orgId;
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== queryKeys.orgs[0] });
  // A load or document open from the old carrier would 404 once refetched.
  // Not on a first pick, which may be landing on a deep-linked screen.
  if (switched) void router.navigate({ to: '/' });
});

/**
 * A link the OS handed the app, while running or from cold. Two kinds:
 *
 *  - **`ai.haulq.app://...`**, the app's own scheme (registered in
 *    `ios/App/App/Info.plist` and `AndroidManifest.xml`). Today that is a
 *    Motive or mailbox connect finishing in the in-app browser and handing
 *    back (`apps/api/src/routes/app-return.ts`). The browser is still on
 *    screen over the app, so it's closed first.
 *  - **An https link** to the app's own paths, for when Universal/App Links
 *    are registered.
 *
 * `inAppPath` turns either into a path, and refuses anything else. A full
 * navigation rather than route-state plumbing: arriving from a link is
 * effectively a cold start anyway, and this keeps `main.tsx` the only place
 * that has to know `CapacitorApp` exists.
 */
CapacitorApp.addListener('appUrlOpen', ({ url }) => {
  const path = inAppPath(url);
  if (!path) return;
  void Browser.close().catch(() => {
    // Not open (a link from Messages, say). Nothing to close.
  });
  window.location.href = path;
});

/**
 * A tapped notification (MOBILE_PARITY_PLAN.md section 7). It opens its path,
 * checked by `pushTapPath`. If it's about a different carrier than the one on
 * screen (one login, several carriers), switch to that carrier first, with a
 * full navigation, because the session listener above resets to `/` on a
 * switch and would otherwise win the race.
 */
listenForPush((data) => {
  const session = readSession();
  const path = pushTapPath(data);
  if (!session?.userId) return;
  const orgId = pushOrgId(data);
  if (orgId && orgId !== session.orgId) {
    const org = queryClient.getQueryData<{ items: OrgSummary[] }>(queryKeys.orgs)?.items.find((o) => o.id === orgId);
    // Name and role from the cached org list when there is one. On a cold
    // start there isn't, and `SubscriptionGate` fills the role in; a carrier
    // this login isn't in is dropped by the same gate.
    writeSession({ userId: session.userId, orgId, ...(org ? { orgName: org.name, role: org.role } : {}) });
    window.location.href = path;
    return;
  }
  router.history.push(path);
});

// Already signed in at launch: refresh this phone's registration.
if (readSession()?.userId) void refreshPushRegistration().catch(() => {});

/**
 * The in-app browser closed without handing back: the person tapped Done,
 * or finished on a page that couldn't reopen the app. A connect may still
 * have gone through on the server, so look again rather than show a stale
 * "not connected".
 */
void Browser.addListener('browserFinished', () => {
  void queryClient.invalidateQueries({ queryKey: queryKeys.integrations });
  void queryClient.invalidateQueries({ queryKey: queryKeys.mailbox });
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
        <ApiClientProvider client={apiClient}>
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
        </ApiClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
