/**
 * The routing-provider interface.
 *
 * PHASE_3_PLAN.md section 7a's own sketch, kept verbatim in shape: one
 * interface, provider chosen per operation, same reasoning `boards/adapter.ts`
 * already applies in the dispatcher repo. `route` and `feasibility` are HERE,
 * permanently — HERE sells the restriction data no open-map source carries at
 * the same quality, and section 7a's own guardrail is explicit that a future
 * self-hosted Valhalla "may never answer `feasibility()`." `matrix` is the one
 * method whose provider is expected to change once 3b's leg counts are
 * measured rather than estimated; it is named here, not implemented, so that
 * day is a new file and a config flag, not a signature change.
 *
 * Every shape below is provider-agnostic on purpose. Nothing here imports
 * `here.ts`, and `here.ts` imports this file, not the other way around — a
 * second provider implements this same interface without editing it.
 */

export interface RoutingStop {
  lat: number;
  lng: number;
}

/**
 * What a truck-safe routing call needs to know about the truck. Field names
 * mirror `schema/fleet.ts`'s `trucks` columns directly — PHASE_3_PLAN.md
 * section 2's whole point is that this data already exists and does not need
 * collecting again.
 */
export interface TruckProfile {
  maxWeightLbs: number | null;
  maxLengthFt: number | null;
  boxHeightIn: number | null;
  boxWidthIn: number | null;
  hazmat: boolean;
}

export interface RouteOptions {
  /** When the truck leaves the first stop. Feeds the provider's time-aware routing, if it has any. */
  departAt: Date;
}

/**
 * A computed route. `raw` carries whatever the provider returned about
 * restrictions it had to route through or around — `feasibility()` reads
 * that, so a provider that changes its wire shape only has to change its own
 * `route()`/`feasibility()` pair, not every caller.
 */
export interface Route {
  miles: number;
  durationSeconds: number;
  arrivalAt: Date;
  raw: unknown;
}

/** One truck-legal reason a route (or a leg of one) cannot be run as-is. */
export interface Restriction {
  code: string;
  description: string;
}

export interface Matrix {
  /** `durations[i][j]` is seconds from `origins[i]` to `destinations[j]`. */
  durations: number[][];
  /** `distances[i][j]` is miles from `origins[i]` to `destinations[j]`. */
  distances: number[][];
}

export interface RoutingProvider {
  route(stops: RoutingStop[], truck: TruckProfile, opts: RouteOptions): Promise<Route>;
  /** Reads `route.raw` for restrictions the route could not avoid. Stays on HERE regardless of what `matrix` does later — see the module note. */
  feasibility(route: Route, truck: TruckProfile): Promise<Restriction[]>;
  matrix(origins: RoutingStop[], destinations: RoutingStop[], truck: TruckProfile): Promise<Matrix>;
}
