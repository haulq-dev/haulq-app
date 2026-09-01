/**
 * HERE Routing API v8, truck mode.
 *
 * PHASE_3_PLAN.md section 7a: HERE, alone, for all of Phase 3 — self-serve
 * signup, published prices, a plain REST call with no batch mode and no async
 * job polling, the same `fetch`-following-Azure/Postmark shape `fmcsa.ts` and
 * `motive.ts` already use for an external call this codebase does not own.
 *
 * SCAFFOLDING NOTE, written before the account exists: `HAULQ_BUILD_PLAN.md`
 * section 11 lists "HERE Platform" as **Later** — a card on file is needed for
 * the 30k/month free tier and that signup has not happened yet. This file is
 * written against HERE's published v8 Routing API request/response shape
 * (`transportMode=truck`, namespaced `truck[...]` parameters, `notices[]` on
 * each route section for a restriction HERE could not route around), not
 * against a captured real response — there is not one yet. Section 7a's own
 * "validate before trusting" discipline applies here a second time: run
 * `here.test.ts`'s fixtures against a real response the day the account
 * activates, before `feasibility()`'s output is trusted for a carrier-facing
 * verdict.
 */

import type {
  Matrix,
  Restriction,
  Route,
  RouteOptions,
  RoutingProvider,
  RoutingStop,
  TruckProfile,
} from './routing-provider.ts';

const HERE_ROUTING_URL = 'https://router.hereapi.com/v8/routes';

export class HereApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HereApiError';
    this.status = status;
  }
}

export interface HereConfig {
  apiKey: string;
}

// --- wire shape --------------------------------------------------------
// HERE's own v8 response, narrowed to the fields this file reads. Everything
// else is passed through as `raw` rather than modeled, same restraint
// `fmcsa.ts`'s `FmcsaCarrierRecord` uses for a response this codebase does
// not own the shape of.

interface HereNotice {
  title?: string;
  code?: string;
  severity?: string;
}

interface HereSection {
  summary?: { length?: number; duration?: number };
  notices?: HereNotice[];
}

interface HereRoute {
  sections?: HereSection[];
}

interface HereRoutesResponse {
  routes?: HereRoute[];
}

const METERS_PER_MILE = 1609.344;

/**
 * Every category HERE's `truck[shippedHazardousGoods]` documents — the
 * `HazardousGoodsRestriction` enum in HERE's own v8 Routing API reference
 * (docs.here.com/routing/reference/routing-api-v8-calculateroutes), not a
 * guess. `loads.hazmat` is a bare boolean with no DOT class detail behind
 * it — nothing upstream records which of these actually applies to a given
 * shipment — so this sends the complete list rather than picking one.
 * Sending every category tells HERE to exclude a road restricted for *any*
 * of them, which is the conservative direction to be wrong in: a hazmat
 * load routed around more restrictions than its real class needs is an
 * inconvenience, and a hazmat load silently allowed on a road actually
 * banned for its real, unrecorded class is a compliance failure
 * `HAULQ_BUILD_PLAN.md` guardrail 2 exists to prevent. Narrow this the day
 * `loads` records a real hazmat class, not before.
 */
const ALL_HAZMAT_CATEGORIES = [
  'explosive',
  'gas',
  'flammable',
  'combustible',
  'organic',
  'poison',
  'radioactive',
  'corrosive',
  'poisonousInhalation',
  'harmfulToWater',
  'other',
] as const;

function truckParams(truck: TruckProfile): URLSearchParams {
  const params = new URLSearchParams();
  // HERE's truck namespace takes metric units (kg, cm) and this schema stores
  // imperial (lbs, in, ft) — see `schema/fleet.ts`. Converted here, once, so
  // nothing upstream has to know the provider's unit system.
  if (truck.maxWeightLbs) {
    params.set('truck[grossWeight]', String(Math.round(truck.maxWeightLbs * 0.45359237)));
  }
  if (truck.boxHeightIn) {
    params.set('truck[height]', String(Math.round(truck.boxHeightIn * 2.54)));
  }
  if (truck.boxWidthIn) {
    params.set('truck[width]', String(Math.round(truck.boxWidthIn * 2.54)));
  }
  if (truck.maxLengthFt) {
    params.set('truck[length]', String(Math.round(truck.maxLengthFt * 30.48)));
  }
  if (truck.hazmat) {
    params.set('truck[shippedHazardousGoods]', ALL_HAZMAT_CATEGORIES.join(','));
  }
  return params;
}

/** Exported for `here-geocode.ts` — a different HERE endpoint, same fetch/error shape. */
export async function hereFetch(url: URL): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new HereApiError(0, `HERE unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new HereApiError(response.status, `HERE ${response.status}: ${text.slice(0, 500)}`);
  }

  return response.json();
}

/**
 * Every HERE notice, regardless of severity. `feasibility()` below is the
 * one place that decides which of these actually make a route infeasible —
 * kept separate so a notice this file has not seen before shows up as a
 * named restriction rather than silently passing a load HERE could not
 * really route.
 */
function noticesFrom(route: Route): HereNotice[] {
  const parsed = route.raw as HereRoutesResponse | undefined;
  const sections = parsed?.routes?.[0]?.sections ?? [];
  return sections.flatMap((s) => s.notices ?? []);
}

export class HereRoutingProvider implements RoutingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: HereConfig, baseUrl: string = HERE_ROUTING_URL) {
    this.apiKey = config.apiKey;
    this.baseUrl = baseUrl;
  }

  async route(stops: RoutingStop[], truck: TruckProfile, _opts: RouteOptions): Promise<Route> {
    if (stops.length < 2) {
      throw new Error('route() needs at least an origin and a destination');
    }

    // The last stop is the destination and everything between the first and
    // last is a via, not the second stop — a load with three or more stops
    // (multi-load sequencing, 3b) would otherwise route straight past its
    // middle stops on the way to what should have been the final via.
    const origin = stops[0]!;
    const destination = stops[stops.length - 1]!;
    const via = stops.slice(1, -1);
    const url = new URL(this.baseUrl);
    url.searchParams.set('transportMode', 'truck');
    url.searchParams.set('origin', `${origin.lat},${origin.lng}`);
    url.searchParams.set('destination', `${destination.lat},${destination.lng}`);
    for (const stop of via) {
      url.searchParams.append('via', `${stop.lat},${stop.lng}`);
    }
    url.searchParams.set('return', 'summary');
    for (const [key, value] of truckParams(truck)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set('apikey', this.apiKey);

    const body = (await hereFetch(url)) as HereRoutesResponse;
    const sections = body.routes?.[0]?.sections ?? [];

    if (sections.length === 0) {
      throw new HereApiError(0, 'HERE returned no route — nothing to evaluate for feasibility');
    }

    const totalMeters = sections.reduce((sum, s) => sum + (s.summary?.length ?? 0), 0);
    const totalSeconds = sections.reduce((sum, s) => sum + (s.summary?.duration ?? 0), 0);

    return {
      miles: totalMeters / METERS_PER_MILE,
      durationSeconds: totalSeconds,
      arrivalAt: new Date(_opts.departAt.getTime() + totalSeconds * 1000),
      raw: body,
    };
  }

  /**
   * Every notice on the route becomes a named restriction. Deliberately not
   * filtered by severity here — PHASE_3_PLAN.md section 1's whole argument is
   * that a load told "no" needs the deciding reason, and dropping a notice
   * this file has not classified yet would silently mark a load feasible
   * that HERE itself flagged. Narrow this once real notices have been seen
   * and a false-positive rate is measurable, not before.
   */
  async feasibility(route: Route, _truck: TruckProfile): Promise<Restriction[]> {
    return noticesFrom(route).map((notice) => ({
      code: notice.code ?? 'unclassified_restriction',
      description: notice.title ?? 'HERE flagged this route without a description.',
    }));
  }

  /**
   * 3b/Phase 4 work — PHASE_3_PLAN.md section 7a names `matrix` as the one
   * method whose provider is expected to change (HERE now, Valhalla once
   * volume is measured). Not implemented in 3a's scaffolding because nothing
   * calls it yet; the interface carries the shape so that day is additive.
   */
  async matrix(_origins: RoutingStop[], _destinations: RoutingStop[], _truck: TruckProfile): Promise<Matrix> {
    throw new Error('matrix() is 3b work, not implemented yet — see PHASE_3_PLAN.md section 7a');
  }
}

// Exported for `here.test.ts` and for any future caller that wants to build
// the same request without a full provider instance (a benchmarking script,
// for instance — section 7a asks for a Trimble distance benchmark, and this
// is the HERE half of that comparison).
export { truckParams as hereTruckParams };
