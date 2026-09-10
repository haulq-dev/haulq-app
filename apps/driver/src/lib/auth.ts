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

/**
 * What's actually wrong with the key, in terms specific enough to act on —
 * the alternative is Clerk's own "Publishable key not valid", which is
 * correct but doesn't say *which* of several very different problems this
 * is: unset, a CI variable substitution that silently didn't resolve, or
 * the secret key pasted where the publishable one belongs. Safe to surface
 * the raw value: a publishable key is meant to be public, and this
 * diagnostic exists specifically so a malformed one is visible, not
 * findable only by decoding a generic failure from a device with no
 * attached debugger. `null` means the key at least has the right shape —
 * still no guarantee Clerk's servers accept it, just that this file isn't
 * the reason they wouldn't.
 */
export function keyProblem(): string | null {
  const key = CLERK_PUBLISHABLE_KEY;
  if (!key) return 'VITE_CLERK_PUBLISHABLE_KEY is empty.';
  if (key.startsWith('$')) {
    return `Received the literal string "${key}" — a build variable reference that never got substituted. Check that VITE_CLERK_PUBLISHABLE_KEY is in a group actually listed under this workflow's environment.groups in codemagic.yaml.`;
  }
  if (key.startsWith('sk_')) {
    return 'Received a Clerk *secret* key (sk_...). This needs the publishable key (pk_test_... or pk_live_...) from the Clerk dashboard\'s API Keys page instead — the secret key must never ship in a client build.';
  }
  if (!key.startsWith('pk_test_') && !key.startsWith('pk_live_')) {
    return `Received "${key}", which doesn't look like a Clerk publishable key (expected it to start with pk_test_ or pk_live_).`;
  }
  return null;
}

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter | null = null;

/** Called once by the Clerk provider after it mounts. */
export function registerTokenGetter(fn: TokenGetter): void {
  getToken = fn;
}

export async function currentToken(): Promise<string | null> {
  return getToken ? getToken() : null;
}
