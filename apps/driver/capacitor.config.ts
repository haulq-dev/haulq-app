/**
 * The native shell config.
 *
 * PHASE_2_PLAN.md section 4's driver-app-stack decision, revisited: J wants a
 * real store listing, and Capacitor is the tool for that — see the session
 * that chose it over Base44 (a whole separate AI app platform with its own
 * backend, a mismatch for an app that already has one) and over a bare
 * webview-wrapper service (no control, no native plugin access).
 *
 * Deliberately no `server.url`. That option points the shell at a live URL
 * for development live-reload — Capacitor's own docs are explicit it is not
 * for production, because the app then shows nothing without a network
 * connection. `apps/web`'s own query client comment already names why that
 * matters here: "cab connectivity is intermittent." Production ships the
 * built `dist/` bundle inside the app; `npm run cap:sync` builds it and
 * copies it into `ios/` and `android/`. The app still calls the real API
 * over the network for data — only the UI shell is local.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.haulq.driver',
  appName: 'HaulQ Driver',
  webDir: 'dist',
};

export default config;
