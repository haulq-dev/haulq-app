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
  appName: 'HaulQ',
  webDir: 'dist',
  // Without this, the WebView's default navigation policy blocks it from
  // loading or talking to any origin outside its own (`capacitor://localhost`)
  // — including Clerk's own Frontend API domain, which its session/cookie
  // handling needs to reach for even a plain email-code sign-in, and which
  // it also loads its own JS bundle from directly (not from this app's own
  // bundle) — so a domain missing here doesn't just break session sync, it
  // can mean Clerk never loads at all.
  //
  // Both entries are needed, not either/or: `clerk.haulq.ai` is this app's
  // actual production Frontend API domain (decode the `pk_live_...` key's
  // payload — see auth.ts's `keyProblem` for that trick — to confirm for
  // any future project); `*.clerk.accounts.dev` is the dev-instance-style
  // domain (`<slug>.clerk.accounts.dev`) every Clerk project also gets, and
  // stays allowlisted so a `pk_test_...` key still works for local
  // debugging without editing this file back and forth.
  //
  // This does NOT fix Google/social sign-in — that's a separate, harder
  // restriction. Google's OAuth policy refuses embedded WebViews outright
  // (`disallowed_useragent`), regardless of what's allowlisted here; only a
  // real browser context (Capacitor's Browser plugin, opening a system
  // Safari/Custom Tabs view) satisfies it, which nothing in this app does
  // yet. Email-code sign-in doesn't hit that restriction at all.
  server: {
    allowNavigation: ['clerk.haulq.ai', '*.clerk.accounts.dev', '*.clerk.com'],
  },
};

export default config;
