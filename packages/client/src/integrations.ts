/**
 * Connected services: what `GET /v1/integrations` returns, and reading the
 * result a connect flow hands back (MOBILE_PARITY_PLAN.md M6).
 */

export interface BoardCredential {
  id: string;
  board: string;
  status: 'unverified' | 'active' | 'failed' | 'revoked';
  tokenExpiresAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface IntegrationsResponse {
  items: BoardCredential[];
  deployment: {
    azureDocumentIntelligence: { configured: boolean };
    anthropicModelPass: { configured: boolean };
    fmcsaVerify: { configured: boolean };
    hereRouting: { configured: boolean };
    motive: { configured: boolean };
  };
}

export interface ConnectResult {
  provider: 'motive' | 'mailbox';
  outcome: string;
  text: string;
  ok: boolean;
}

const MOTIVE_RESULT: Record<string, { text: string; ok: boolean }> = {
  connected: { text: 'Motive is connected. Match each truck to its Motive vehicle from Trucks.', ok: true },
  denied: { text: 'The Motive connection was cancelled.', ok: false },
  error: { text: 'Something went wrong connecting Motive. Try again.', ok: false },
  not_configured: { text: 'Motive approved it, but HaulQ couldn’t finish the setup on its side. This needs us to fix, not a retry.', ok: false },
};

const MAILBOX_RESULT: Record<string, { text: string; ok: boolean }> = {
  connected: { text: 'Mailbox connected. It can take a moment to show as connected.', ok: true },
  denied: { text: 'The mailbox connection was cancelled.', ok: false },
};

/**
 * What `?motive=` or `?mailbox=` on the return URL means, in words. Anything
 * unrecognised is ignored, so a hand-edited link can't show a false banner.
 */
export function connectResult(search: string): ConnectResult | null {
  const params = new URLSearchParams(search);
  const motive = params.get('motive');
  const m = motive ? MOTIVE_RESULT[motive] : undefined;
  if (motive && m) return { provider: 'motive', outcome: motive, ...m };
  const mailbox = params.get('mailbox');
  const b = mailbox ? MAILBOX_RESULT[mailbox] : undefined;
  if (mailbox && b) return { provider: 'mailbox', outcome: mailbox, ...b };
  return null;
}

/**
 * The in-app path for a URL the OS hands the app: an https link
 * (`https://app.haulq.ai/invite/abc` → `/invite/abc`) or the app's own
 * scheme (`ai.haulq.app://integrations?x=1` → `/integrations?x=1`), where
 * the "host" is really the first path segment. `null` for anything else.
 */
export function inAppPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'ai.haulq.app:') {
    const path = `/${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/{2,}/g, '/');
    return `${path}${parsed.search}`;
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return `${parsed.pathname}${parsed.search}`;
  return null;
}
