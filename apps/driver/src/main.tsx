/**
 * App shell.
 *
 * One screen — `CheckinScreen` handles its own two states (paste a link, or
 * a token already in the path) internally, so there is no router here at
 * all. A router is a guess about how many screens this app will eventually
 * have; today it has one.
 */

import { App as CapacitorApp } from '@capacitor/app';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CheckinScreen } from './routes/Checkin.tsx';
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
      <CheckinScreen />
    </QueryClientProvider>
  </StrictMode>,
);
