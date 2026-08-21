/**
 * Motive's OAuth endpoints.
 *
 * PHASE_2_PLAN.md section 5: "a real Motive call before estimating further,
 * not after." This is that call, made against the documentation Motive
 * actually publishes rather than a guess — `developer-docs.gomotive.com`'s
 * OAuth 2.0 guide names these two URLs, the exact token-exchange body shape,
 * and the two-hour access-token lifetime below.
 *
 * Deliberately just the OAuth mechanics. Fetching `/v3/vehicle_locations`
 * and turning a response into `truck_positions` rows is 2b's adapter, not
 * built yet — this is the credential-connection half only.
 */

const AUTHORIZE_URL = 'https://gomotive.com/oauth/authorize';
const TOKEN_URL = 'https://api.gomotive.com/oauth/token';

/**
 * Read access to vehicle locations and vehicle identity — the second so a
 * carrier can map a Motive vehicle to a HaulQ truck, the first for the
 * position feed itself. Not requesting HOS scopes: PHASE_2_PLAN.md section 5
 * suspects pulling HOS is actually Phase 4 (Dispatch)'s job, and asking for
 * a scope this integration does not use yet is a permission a carrier has
 * to trust for no reason.
 */
const SCOPES = ['locations.vehicle_locations_list', 'vehicles.read'];

export interface MotiveOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function motiveAuthorizeUrl(config: Pick<MotiveOAuthConfig, 'clientId' | 'redirectUri'>, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

export interface MotiveTokens {
  accessToken: string;
  refreshToken: string;
  /** Computed from the response's `expires_in` (seconds) at call time. */
  expiresAt: Date;
}

export class MotiveApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MotiveApiError';
    this.status = status;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function parseTokenResponse(body: TokenResponse): MotiveTokens {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}

async function postToken(params: URLSearchParams): Promise<MotiveTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new MotiveApiError(response.status, `motive token endpoint ${response.status}: ${text.slice(0, 500)}`);
  }

  return parseTokenResponse((await response.json()) as TokenResponse);
}

/** The authorization code is valid for 10 minutes — Motive's own docs name that window. */
export function exchangeMotiveCode(config: MotiveOAuthConfig, code: string): Promise<MotiveTokens> {
  return postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  );
}

export function refreshMotiveTokens(config: MotiveOAuthConfig, refreshToken: string): Promise<MotiveTokens> {
  return postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  );
}
