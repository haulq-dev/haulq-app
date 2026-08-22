/**
 * Fetching Motive's vehicle positions and writing them into `truck_positions`.
 *
 * PHASE_2_PLAN.md section 5's exit gate: "A truck running a real ELD reports
 * position without the driver doing anything, using the same table and the
 * same carrier-facing screens 2a already built." `recordTruckPosition`
 * (`repositories/track.ts`) is that table — this calls it with `source:
 * 'eld'` instead of `'driver_app'`, and nothing downstream (the tracking
 * page, detention, ETA) has to know the difference.
 *
 * The request/response shape below is verified against
 * developer-docs.gomotive.com's actual reference for
 * `GET /v3/vehicle_locations`, not guessed — same discipline
 * `ai-load-dispatcher/docs/DAT_CALL_CHECKLIST.md` already insists on for a
 * different board: "Do not write more integration code first — filling it
 * in from blog posts is how you ship a poller that silently returns
 * nothing." Notably, each vehicle is nested `{ vehicle: { current_location:
 * {...} } }`, not flat — easy to get wrong without checking.
 */

import { randomUUID } from 'node:crypto';
import {
  decryptCredential,
  encryptCredential,
  listActiveOAuthCredentials,
  markCredentialFailed,
  recordTruckPosition,
  scope,
  trucksByMotiveVehicleId,
  updateOAuthTokens,
  type BoardCredential,
  type Database,
} from '@haulq/db';
import { MotiveApiError, refreshMotiveTokens, type MotiveOAuthConfig } from './motive.ts';

const VEHICLE_LOCATIONS_URL = 'https://api.gomotive.com/v3/vehicle_locations';

interface MotiveVehicleLocation {
  vehicleId: number;
  lat: number;
  lng: number;
  locatedAt: Date;
}

interface MotiveLocationsResponse {
  vehicles: Array<{
    vehicle: {
      id: number;
      current_location?: { lat: number; lon: number; located_at: string } | null;
    };
  }>;
  pagination: { per_page: number; page_no: number; total: number };
}

export interface ParsedMotivePage {
  locations: MotiveVehicleLocation[];
  /** True when another `page_no` needs fetching to see every vehicle. */
  hasNextPage: boolean;
}

/**
 * Pure, and exhaustively tested for it — this is the part actually worth
 * getting right. `fetchMotiveVehicleLocations` below is deliberately thin
 * around it, same split `model-reader.ts` makes between `parseModelResponse`
 * (tested hard) and the HTTP call itself (one integration-style check,
 * because a stubbed `fetch` proves nothing about what the real API sends).
 */
export function parseMotiveLocationsPage(body: MotiveLocationsResponse): ParsedMotivePage {
  const locations: MotiveVehicleLocation[] = [];

  for (const entry of body.vehicles) {
    const loc = entry.vehicle.current_location;
    // No position reported yet for this vehicle — skipped, not zeroed. A
    // fabricated (0, 0) would be a worse answer than "nothing this pass."
    if (!loc) continue;
    locations.push({
      vehicleId: entry.vehicle.id,
      lat: loc.lat,
      lng: loc.lon,
      locatedAt: new Date(loc.located_at),
    });
  }

  const { per_page, page_no, total } = body.pagination;
  return { locations, hasNextPage: page_no * per_page < total };
}

/** Every vehicle with a reported position, across all pages. */
export async function fetchMotiveVehicleLocations(accessToken: string): Promise<MotiveVehicleLocation[]> {
  const results: MotiveVehicleLocation[] = [];
  let pageNo = 1;

  for (;;) {
    const url = new URL(VEHICLE_LOCATIONS_URL);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page_no', String(pageNo));

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new MotiveApiError(response.status, `motive vehicle_locations ${response.status}: ${text.slice(0, 500)}`);
    }

    const page = parseMotiveLocationsPage((await response.json()) as MotiveLocationsResponse);
    results.push(...page.locations);
    if (!page.hasNextPage) break;
    pageNo += 1;
  }

  return results;
}

export interface SyncDeps {
  db: Database;
  config: MotiveOAuthConfig;
  publicKey: string;
  privateKey: string;
  log: { info: (o: unknown, msg: string) => void; warn: (o: unknown, msg: string) => void };
}

/** Refresh window — same margin a browser's own token-refresh logic would use, so a slow poll never races an about-to-expire token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

async function accessTokenFor(deps: SyncDeps, credential: BoardCredential): Promise<string> {
  // Null only if this row is somehow secretRef-shaped rather than OAuth —
  // `board_credentials_oauth_has_expiry` should make that impossible for a
  // row this function is ever called with. Treated as "refresh now" rather
  // than crashing on a guarantee the database is supposed to hold anyway.
  const expiresSoon =
    !credential.tokenExpiresAt || credential.tokenExpiresAt.getTime() < Date.now() + REFRESH_MARGIN_MS;
  if (!expiresSoon) {
    return decryptCredential(deps.publicKey, deps.privateKey, credential.encryptedAccessToken!);
  }

  const refreshToken = await decryptCredential(deps.publicKey, deps.privateKey, credential.encryptedRefreshToken!);
  const tokens = await refreshMotiveTokens(deps.config, refreshToken);
  const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
    encryptCredential(deps.publicKey, tokens.accessToken),
    encryptCredential(deps.publicKey, tokens.refreshToken),
  ]);

  const s = scope(deps.db, {
    orgId: credential.orgId,
    actor: { type: 'system', name: 'motive-sync' },
    correlationId: randomUUID(),
  });
  await updateOAuthTokens(s, credential.id, { encryptedAccessToken, encryptedRefreshToken, expiresAt: tokens.expiresAt });

  return tokens.accessToken;
}

/** One org's positions, for one pass. Returns how many trucks actually got a fresh position. */
async function syncOrg(deps: SyncDeps, credential: BoardCredential): Promise<number> {
  const accessToken = await accessTokenFor(deps, credential);
  const [locations, truckByVehicle] = await Promise.all([
    fetchMotiveVehicleLocations(accessToken),
    trucksByMotiveVehicleId(deps.db, credential.orgId),
  ]);

  let written = 0;
  for (const loc of locations) {
    const truckId = truckByVehicle.get(loc.vehicleId);
    // Motive knows about a vehicle nobody has matched to a HaulQ truck yet —
    // routes/trucks.ts's motive-vehicle endpoint is how that gets fixed, not
    // this loop guessing at a match.
    if (!truckId) continue;

    await recordTruckPosition(deps.db, {
      orgId: credential.orgId,
      truckId,
      lat: loc.lat,
      lng: loc.lng,
      recordedAt: loc.locatedAt,
      source: 'eld',
    });
    written += 1;
  }

  return written;
}

export interface SyncResult {
  orgsAttempted: number;
  positionsWritten: number;
}

/**
 * One pass across every org connected to Motive.
 *
 * A failure in one org's sync must not stop another's — same reasoning the
 * outbox's own batch handling already has for "a failure in one message
 * does not abandon the rest." Only an authentication failure (the refresh
 * token itself was revoked — Motive answers that with 400/401) marks the
 * connection `failed`; anything else is a transient error worth quietly
 * retrying next pass rather than a reason to stop syncing until a carrier
 * reconnects.
 */
export async function syncAllMotivePositions(deps: SyncDeps): Promise<SyncResult> {
  const credentials = await listActiveOAuthCredentials(deps.db, 'motive');
  let positionsWritten = 0;

  for (const credential of credentials) {
    try {
      positionsWritten += await syncOrg(deps, credential);
    } catch (err) {
      const authFailure = err instanceof MotiveApiError && (err.status === 400 || err.status === 401);
      deps.log.warn(
        { orgId: credential.orgId, err: err instanceof Error ? err.message : String(err), authFailure },
        'motive sync failed for org',
      );

      if (authFailure) {
        const s = scope(deps.db, {
          orgId: credential.orgId,
          actor: { type: 'system', name: 'motive-sync' },
          correlationId: randomUUID(),
        });
        await markCredentialFailed(s, credential.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { orgsAttempted: credentials.length, positionsWritten };
}
