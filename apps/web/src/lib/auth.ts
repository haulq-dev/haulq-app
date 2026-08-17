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

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter | null = null;

/** Called once by the Clerk provider after it mounts. */
export function registerTokenGetter(fn: TokenGetter): void {
  getToken = fn;
}

export async function currentToken(): Promise<string | null> {
  return getToken ? getToken() : null;
}
