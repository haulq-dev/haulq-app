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
  // handling needs to reach even for a plain email-code sign-in, not just
  // OAuth. Sign-in appeared to "work" (a code arrived, the code was
  // accepted) but silently bounced back to the sign-in screen instead of
  // landing on a real session — this is why. The wildcard is Clerk's own
  // convention (every instance gets a `<slug>.clerk.accounts.dev` Frontend
  // API domain, or a custom one under `clerk.<yourdomain>` if that's ever
  // configured) — decode the `pk_...` key's payload to find a given
  // instance's domain if this ever needs updating for a different Clerk
  // project.
  //
  // This does NOT fix Google/social sign-in — that's a separate, harder
  // restriction. Google's OAuth policy refuses embedded WebViews outright
  // (`disallowed_useragent`), regardless of what's allowlisted here; only a
  // real browser context (Capacitor's Browser plugin, opening a system
  // Safari/Custom Tabs view) satisfies it, which nothing in this app does
  // yet. Email-code sign-in doesn't hit that restriction at all.
  server: {
    allowNavigation: ['*.clerk.accounts.dev', '*.clerk.com'],
  },
};

export default config;
