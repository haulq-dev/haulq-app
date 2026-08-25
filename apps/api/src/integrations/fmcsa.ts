/**
 * FMCSA's QCMobile carrier lookup.
 *
 * `PHASE_0B_PLAN.md`'s whole finding: this call already runs in production on
 * `haulq-site`'s `/api/verify` — this is that same request and response
 * mapping, ported rather than reinvented, so the tenant-scoped app inherits
 * an integration already proven against the real API instead of guessing at
 * its shape a second time. The endpoint's own doubled-digits shape is that
 * tool's discovery, kept verbatim: a docket number needs
 * `/docket-number/{digits}`, a bare DOT number needs `/{digits}`, and which
 * one a carrier typed is guessed from length rather than asked for
 * separately, since a carrier types "MC 123456" and "123456" for the same
 * number depending on the day.
 */

const FMCSA = 'https://mobile.fmcsa.dot.gov/qc/services/carriers';

export class FmcsaError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FmcsaError';
    this.status = status;
  }
}

export interface FmcsaCarrier {
  found: boolean;
  legalName: string | null;
  dbaName: string | null;
  dotNumber: string | null;
  /** 'Authorized' | 'Not authorized' | 'Unknown', mapped from `allowedToOperate`. */
  operatingStatus: string | null;
  entityType: string | null;
  powerUnits: number | null;
  drivers: number | null;
  safetyRating: string | null;
  location: string | null;
  /** Untouched, for `broker_verifications.raw` — same reasoning `loads.raw` uses. */
  raw: unknown;
}

interface FmcsaResponseBody {
  content?:
    | Array<{ carrier?: FmcsaCarrierRecord }>
    | { carrier?: FmcsaCarrierRecord };
}

interface FmcsaCarrierRecord {
  legalName?: string;
  dbaName?: string;
  dotNumber?: string;
  allowedToOperate?: string;
  carrierOperation?: { carrierOperationDesc?: string };
  totalPowerUnits?: number;
  totalDrivers?: number;
  safetyRating?: string;
  phyCity?: string;
  phyState?: string;
}

/**
 * Look up a carrier by MC/docket number or DOT number.
 *
 * `baseUrl` is overridable for tests, the same seam `azure-reader.ts` and
 * `motive.ts` both already use for an external REST call. Throws
 * `FmcsaError` on a transport failure (a 5xx, unreachable) — retryable, same
 * split `azure-reader.ts` draws between "the service failed" and "the
 * service answered and found nothing," which is a `found: false` result, not
 * a thrown error.
 */
export async function lookupCarrier(
  query: string,
  webKey: string,
  baseUrl: string = FMCSA,
): Promise<FmcsaCarrier> {
  const digits = query.replace(/\D/g, '');
  if (!digits) {
    return {
      found: false,
      legalName: null,
      dbaName: null,
      dotNumber: null,
      operatingStatus: null,
      entityType: null,
      powerUnits: null,
      drivers: null,
      safetyRating: null,
      location: null,
      raw: null,
    };
  }

  // A docket (MC/MX/FF) number is conventionally shorter than a DOT number
  // and is what a carrier usually has memorized — same heuristic the site's
  // tool already uses, since FMCSA gives no single endpoint that accepts
  // either kind of number without knowing which it is first.
  const isDocket = /mc|mx|ff/i.test(query) || digits.length <= 6;
  const url = isDocket
    ? `${baseUrl}/docket-number/${digits}?webKey=${webKey}`
    : `${baseUrl}/${digits}?webKey=${webKey}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new FmcsaError(0, `FMCSA unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    throw new FmcsaError(response.status, `FMCSA ${response.status}`);
  }

  const payload = (await response.json()) as FmcsaResponseBody;
  const content = payload.content;
  const record = Array.isArray(content) ? content[0]?.carrier : content?.carrier;

  if (!record) {
    return {
      found: false,
      legalName: null,
      dbaName: null,
      dotNumber: null,
      operatingStatus: null,
      entityType: null,
      powerUnits: null,
      drivers: null,
      safetyRating: null,
      location: null,
      raw: payload,
    };
  }

  const operatingStatus =
    record.allowedToOperate === 'Y'
      ? 'Authorized'
      : record.allowedToOperate === 'N'
        ? 'Not authorized'
        : 'Unknown';

  return {
    found: true,
    legalName: record.legalName ?? null,
    dbaName: record.dbaName ?? null,
    dotNumber: record.dotNumber ?? null,
    operatingStatus,
    entityType: record.carrierOperation?.carrierOperationDesc ?? null,
    powerUnits: record.totalPowerUnits ?? null,
    drivers: record.totalDrivers ?? null,
    safetyRating: record.safetyRating ?? null,
    location: [record.phyCity, record.phyState].filter(Boolean).join(', ') || null,
    raw: payload,
  };
}
