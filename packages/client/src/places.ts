/**
 * Nearby stops and nearby repair shops: the small rules both apps share.
 * `FEATURE_REQUESTS_PLAN.md` sections 3 and 4. The hooks that fetch these are
 * in `react.ts`; this is what turns the answer into something readable.
 *
 * Both are live lookups against a vendor (HERE for stops, Yelp for shops) and
 * store nothing, so the searches here are *asked for*, never run on their own.
 */

import type { Mechanic, NearbyPlace } from '@haulq/contracts';

export type { Mechanic, NearbyMechanicsResponse, NearbyPlace, NearbyStopsResponse, StopNearbyPlaces } from '@haulq/contracts';

// --- nearby stops -------------------------------------------------------------------

/** How far from each stop to look. The API's own ceiling is 50. */
export const STOP_RADIUS_OPTIONS = [5, 10, 25, 50] as const;
export const DEFAULT_STOP_RADIUS = 10;

/** What a place is, in the order a driver looks for it. */
export const STOP_CATEGORY_ORDER: ReadonlyArray<{ value: NearbyPlace['category']; label: string }> = [
  { value: 'truckStop', label: 'Truck stops' },
  { value: 'fuelStation', label: 'Fuel' },
  { value: 'restArea', label: 'Rest areas' },
  { value: 'weighStation', label: 'Weigh stations' },
  { value: 'truckWash', label: 'Truck washes' },
];

/**
 * A stop's places grouped by kind, in the fixed order above, nearest first
 * inside each. A kind with nothing in it is left out, so the list only says
 * what there is.
 */
export function groupPlaces(places: readonly NearbyPlace[]): Array<{ category: NearbyPlace['category']; label: string; places: NearbyPlace[] }> {
  const groups: Array<{ category: NearbyPlace['category']; label: string; places: NearbyPlace[] }> = [];
  for (const { value, label } of STOP_CATEGORY_ORDER) {
    const inKind = places.filter((p) => p.category === value).sort((a, b) => a.distanceMiles - b.distanceMiles);
    if (inKind.length > 0) groups.push({ category: value, label, places: inKind });
  }
  return groups;
}

/** A link that opens the place on a map. Web only; a phone opens its own maps app. */
export function mapsUrl(place: Pick<NearbyPlace, 'name' | 'lat' | 'lng'>): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.name} ${place.lat},${place.lng}`)}`;
}

/**
 * HERE's address label starts with the place's own name and ends with the
 * country ("QuikTrip, 1010 E Douglas Ave, Wichita, KS 67214, United States"),
 * which is noise under a heading that already says both. Null if nothing is left.
 */
export function tidyAddress(name: string, address: string | null): string | null {
  if (!address) return null;
  let tidy = address.replace(/,\s*United States$/i, '').trim();
  if (tidy.toLowerCase().startsWith(name.toLowerCase() + ',')) tidy = tidy.slice(name.length + 1).trim();
  // Nothing but the name left: there is no address to show.
  return tidy === '' || tidy.toLowerCase() === name.toLowerCase() ? null : tidy;
}

export function formatMiles(miles: number): string {
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

// --- nearby repair shops ------------------------------------------------------------

/** How far to look. Yelp's own ceiling, through the API, is 24. */
export const MECHANIC_RADIUS_OPTIONS = [5, 10, 15, 24] as const;
export const DEFAULT_MECHANIC_RADIUS = 15;

/**
 * What to search for. Free text is what Yelp takes, so these are shortcuts, not
 * a closed list. Each also names the Yelp categories that mean the right kind
 * of business: without them, a towing or tire search returned ordinary garages.
 * A search the person typed themselves sends no categories, and only its words
 * decide. The aliases are the ones Yelp returned real results for.
 */
export const MECHANIC_SEARCHES: ReadonlyArray<{ label: string; query: string; categories: string }> = [
  { label: 'Diesel truck repair', query: 'diesel truck repair', categories: 'truckrepair,autorepair' },
  { label: 'Tires', query: 'truck tire', categories: 'tires' },
  { label: 'Towing', query: 'heavy duty towing', categories: 'towing' },
  { label: 'Trailer / reefer repair', query: 'reefer trailer repair', categories: 'trailerrepair,truckrepair' },
];

/** A search that has been asked for. The hook stays idle until there is one. */
export interface MechanicSearch {
  lat: number;
  lng: number;
  radiusMiles: number;
  query: string;
  /** Yelp category aliases, or none for a typed search. */
  categories?: string | undefined;
}

/** "4.5 (123 reviews)", or "Not rated" for a business Yelp has no rating for. */
export function formatRating(mechanic: Pick<Mechanic, 'rating' | 'reviewCount'>): string {
  if (mechanic.rating === null) return 'Not rated';
  const reviews = `${mechanic.reviewCount} review${mechanic.reviewCount === 1 ? '' : 's'}`;
  return `${mechanic.rating.toFixed(1)} (${reviews})`;
}

/** A phone number a phone can dial. Null when there is nothing dialable. */
export function telHref(phone: string | null): string | null {
  const digits = phone?.replace(/[^\d+]/g, '') ?? '';
  return digits.length >= 7 ? `tel:${digits}` : null;
}

/** Where a search could start, from what a load already knows. */
export interface SearchOrigin {
  key: string;
  label: string;
  lat: number;
  lng: number;
}

/**
 * The places worth searching from, for one load: where the truck last
 * reported, then each stop that has coordinates. A stop with none is left out
 * rather than guessed at. The truck comes first because a breakdown is about
 * where it is now.
 */
export function searchOrigins(input: {
  truck: { label: string | null; currentCity: string | null; currentState: string | null; currentLat: number | null; currentLng: number | null } | null | undefined;
  stops: ReadonlyArray<{ seq: number; type: string; city: string; state: string; lat: number | null; lng: number | null }>;
}): SearchOrigin[] {
  const origins: SearchOrigin[] = [];
  const t = input.truck;
  if (t && t.currentLat !== null && t.currentLng !== null) {
    const where = t.currentCity ? ` — ${t.currentCity}, ${t.currentState ?? ''}`.replace(/, $/, '') : '';
    origins.push({ key: 'truck', label: `${t.label ?? 'The truck'}, last reported position${where}`, lat: t.currentLat, lng: t.currentLng });
  }
  for (const s of [...input.stops].sort((a, b) => a.seq - b.seq)) {
    if (s.lat === null || s.lng === null) continue;
    origins.push({
      key: `stop-${s.seq}`,
      label: `${s.type === 'pickup' ? 'Pickup' : 'Delivery'}: ${s.city}, ${s.state}`,
      lat: s.lat,
      lng: s.lng,
    });
  }
  return origins;
}
