/**
 * How the API client gets a credential, for a signed-in driver.
 *
 * Trimmed from `apps/web`'s copy of this file: web has to support both a
 * Clerk build and a header-based dev build from one codebase, because
 * `pnpm dev` has to work with no Clerk account on a laptop. This app has
 * exactly one deploy target — TestFlight/the App Store — so there is no dev
 * mode to fall back to. `VITE_CLERK_PUBLISHABLE_KEY` is required; see
 * `AuthGate.tsx`'s own note on what happens when it's missing.
 *
 * The indirection below exists for the same reason web's does: `request()`
 * in `api.ts` is a plain function, and Clerk's token lives behind a React
 * hook. The provider registers a getter here once, after mounting, and the
 * client asks for it — one module-level mutable, rather than threading a
 * token through every call site.
 *
 * None of this touches the anonymous check-in link flow in `Checkin.tsx` —
 * that remains token-authenticated and sign-in-free, on purpose, for a
 * driver who hasn't linked an account yet. See its own module note.
 */

export const CLERK_PUBLISHABLE_KEY =
  (import.meta.env['VITE_CLERK_PUBLISHABLE_KEY'] as string | undefined) ?? '';

export const usingClerk = CLERK_PUBLISHABLE_KEY.length > 0;

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter | null = null;

/** Called once by the Clerk provider after it mounts. */
export function registerTokenGetter(fn: TokenGetter): void {
  getToken = fn;
}

export async function currentToken(): Promise<string | null> {
  return getToken ? getToken() : null;
}
