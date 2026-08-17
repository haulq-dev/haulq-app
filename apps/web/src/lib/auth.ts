/**
 * How the API client gets a credential.
 *
 * Two modes, chosen by whether `VITE_CLERK_PUBLISHABLE_KEY` is set at build
 * time:
 *
 *   clerk  — a real session token on every request
 *   dev    — the org/user headers `DevAuthenticator` reads
 *
 * The indirection exists because `request()` is a plain function and Clerk's
 * token lives behind a React hook. Rather than thread a token through every
 * call site, the provider registers a getter here once and the client asks for
 * it. One module-level mutable, in exchange for not having auth leak into the
 * signature of every data function.
 */

export const CLERK_PUBLISHABLE_KEY =
  (import.meta.env['VITE_CLERK_PUBLISHABLE_KEY'] as string | undefined) ?? '';

/** True when this build is configured for real authentication. */
export const usingClerk = CLERK_PUBLISHABLE_KEY.length > 0;

/**
 * The dangerous combination: talking to a deployed API with no real auth.
 *
 * A missing publishable key makes the app fall back to dev headers, which a
 * production API refuses — so every request 401s and the sign-in screen never
 * appears. That is a broken deploy, but it *looks* like an ordinary bug, and
 * the cause is a build-time variable nobody thinks to check.
 *
 * So it is detected rather than left to be discovered. Pointing at localhost is
 * fine and stays fine; pointing anywhere else without a key is not.
 */
const apiUrl = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';
const apiIsRemote =
  apiUrl.startsWith('http') && !/localhost|127\.0\.0\.1/.test(apiUrl);

export const misconfigured = apiIsRemote && !usingClerk;

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter | null = null;

/** Called once by the Clerk provider after it mounts. */
export function registerTokenGetter(fn: TokenGetter): void {
  getToken = fn;
}

export async function currentToken(): Promise<string | null> {
  return getToken ? getToken() : null;
}
