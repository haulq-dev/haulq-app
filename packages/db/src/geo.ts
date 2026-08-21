/**
 * Distance and ETA estimation.
 *
 * Duplicated from `ai-load-dispatcher/packages/core/src/distance.ts` rather
 * than imported — ADR-0001 keeps `haulq-app` and `haulq-dispatcher`
 * deliberately unlinked until Phase 4, and a great-circle-distance formula
 * is exactly the kind of small, stable pure function worth copying rather
 * than wiring a workspace link across that boundary for. If the formula
 * changes, both files change; see the ADR for the reasoning.
 *
 * PHASE_2_PLAN.md section 7 answers the open question here: reuse this
 * approximation for the broker tracking page's ETA rather than waiting on
 * Phase 3's routing-provider decision. The dispatcher core's own comment on
 * `estimatedRoadMiles` is the caveat that travels with it unchanged:
 * "Good enough to decide whether to look at a load. Not good enough to
 * quote a customer." An ETA on a tracking page is the same screening-grade
 * use case a broker is not disputing a detention charge against.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_MI = 3958.8;

/** Great-circle distance in statute miles. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

/**
 * Roads are not straight lines. Same factor and the same reference check
 * the dispatcher core's own file carries — lands within roughly 10% of real
 * driving miles for US interstate routes.
 */
export const ROAD_FACTOR = 1.15;

export function estimatedRoadMiles(a: GeoPoint, b: GeoPoint): number {
  return Math.round(haversineMiles(a, b) * ROAD_FACTOR);
}

/**
 * Average trip speed, not cruising speed — it has to absorb fuel stops,
 * traffic and mandatory HOS breaks. 50 mph is a common load-board rule of
 * thumb for "when will this truck get there," not a measured figure.
 */
export const ASSUMED_AVG_SPEED_MPH = 50;

export interface EstimatedArrival {
  milesRemaining: number;
  arrivalAt: Date;
}

/** When a truck at `from` should reach `to`, at the assumed average speed. */
export function estimatedArrival(from: GeoPoint, to: GeoPoint, now = new Date()): EstimatedArrival {
  const milesRemaining = estimatedRoadMiles(from, to);
  const hours = milesRemaining / ASSUMED_AVG_SPEED_MPH;
  return { milesRemaining, arrivalAt: new Date(now.getTime() + hours * 3_600_000) };
}
