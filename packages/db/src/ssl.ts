/**
 * Deciding whether to use TLS.
 *
 * Render requires TLS on **external** connections and does not use it on the
 * internal network. postgres.js defaults to no TLS, so a connection string
 * copied from the dashboard's "External" tab fails with `SSL/TLS required` —
 * a `28000` authentication error, which reads like a credentials problem and
 * is not one.
 *
 * Rather than make everyone remember `?sslmode=require`, the mode is derived:
 *
 *  - an explicit `sslmode` in the URL always wins
 *  - a local host (localhost, 127.0.0.1, a socket) gets no TLS
 *  - anything else gets TLS
 *
 * `require` rather than `verify-full`: it encrypts the connection but does not
 * verify the server certificate against a CA. Verification would need Render's
 * CA bundle shipped and kept current, and the realistic threat here — someone
 * reading a carrier's records off the wire — is addressed by encryption. Worth
 * revisiting if the database ever moves somewhere with a public CA chain.
 */

export type SslMode = boolean | 'require' | 'allow' | 'prefer' | 'verify-full';

const LOCAL = /^(localhost|127\.0\.0\.1|::1|\/)/;

export function sslFor(url: string): SslMode {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable — let postgres.js produce its own error rather than guessing.
    return false;
  }

  const explicit = parsed.searchParams.get('sslmode');
  if (explicit) {
    if (explicit === 'disable') return false;
    if (explicit === 'require' || explicit === 'allow' || explicit === 'prefer') {
      return explicit;
    }
    if (explicit === 'verify-ca' || explicit === 'verify-full') return 'verify-full';
  }

  return LOCAL.test(parsed.hostname) ? false : 'require';
}
