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
  // Matches what actually got registered in App Store Connect — Apple
  // wouldn't take 'ai.haulq.driver' when the account tried, only
  // 'ai.haulq.app'. Every native project (ios/, android/) was already
  // generated against the old id and had to be updated by hand to match;
  // if this ever needs to change again, `ios/App/App.xcodeproj/project.pbxproj`'s
  // two `PRODUCT_BUNDLE_IDENTIFIER` lines and `android/app/build.gradle`'s
  // `namespace`/`applicationId` need the same edit, not just this file.
  appId: 'ai.haulq.app',
  appName: 'HaulQ Driver',
  webDir: 'dist',
};

export default config;
