/**
 * HERE Geocoding & Search API v7 — `/browse`, truck-relevant POI.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 4: the truck-relevant POI data
 * `PHASE_3_PLAN.md` section 2 named as a Routes gap ("low bridges,
 * restricted roads, scales, parking, service points") sits inside the same
 * HERE account `here.ts` and `here-geocode.ts` already hold a key for —
 * `/browse`, not a separate product or a second vendor. Category IDs below
 * are copied from HERE's own published category system
 * (docs.here.com/geocoding-and-search/docs/places-category-system-full),
 * checked there directly on 2026-09-14, not guessed. Same `fetch`/error
 * shape `here.ts` and `here-geocode.ts` both already use for this account —
 * see `here.ts`'s module note.
 *
 * What this does not give you: whether a stop has an open space *right
 * now*. These are static place records — location and existence, not live
 * occupancy. Real-time parking availability is a different product (Argus
 * AI, named in `FEATURE_REQUESTS_PLAN.md` section 4) and deliberately out
 * of scope here.
 */

import { hereFetch, type HereConfig } from './here.ts';

const HERE_BROWSE_URL = 'https://browse.search.hereapi.com/v1/browse';

const METERS_PER_MILE = 1609.344;

/**
 * Enough of each kind to show a real choice at a stop without turning into a
 * directory. Per kind, not overall: see `nearbyStops`.
 */
const RESULTS_PER_CATEGORY = 5;

/**
 * Every category this file asks for, with HERE's own category ID — see
 * this file's module note on where these came from. `700-7600-0323` (EV
 * Charging Station for Trucks) is deliberately excluded: HERE's own docs
 * flag it as needing a separate license add-on, unlike everything below.
 */
export const NEARBY_STOP_CATEGORIES = {
  truckStop: { id: '700-7900-0132', label: 'Truck Stop / Plaza' },
  weighStation: { id: '400-4200-0048', label: 'Weigh Station' },
  restArea: { id: '400-4300-0000', label: 'Rest Area' },
  truckWash: { id: '700-7900-0323', label: 'Truck Wash' },
  fuelStation: { id: '700-7600-0116', label: 'Fuel Station' },
} as const;

export type NearbyStopCategory = keyof typeof NEARBY_STOP_CATEGORIES;

export interface NearbyPlace {
  name: string;
  category: NearbyStopCategory;
  categoryLabel: string;
  lat: number;
  lng: number;
  distanceMiles: number;
  /** HERE's resolved address string, when it has one. */
  address: string | null;
}

// --- wire shape ----------------------------------------------------------
// HERE's own /browse response, narrowed to the fields this file reads —
// same restraint `here.ts` and `here-geocode.ts` already apply to a
// response this codebase does not own the shape of.
interface HereBrowseItem {
  title?: string;
  categories?: Array<{ id?: string }>;
  position?: { lat: number; lng: number };
  /** Meters from the query center — HERE computes this, this file does not. */
  distance?: number;
  address?: { label?: string };
}

interface HereBrowseResponse {
  items?: HereBrowseItem[];
}

/**
 * Separate from `HerePlacesProvider` for the same reason `Geocoder` is
 * separate from `HereGeocoder` — so a test, or a future route, can inject a
 * fake with no HERE account. See `feasibility.test.ts`'s `FakeRoutingProvider`
 * for the same pattern against `RoutingProvider`.
 */
export interface PlacesProvider {
  /** Truck-relevant POI within `radiusMeters` of a point, closest first. */
  nearbyStops(lat: number, lng: number, radiusMeters: number): Promise<NearbyPlace[]>;
}

export class HerePlacesProvider implements PlacesProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: HereConfig, baseUrl: string = HERE_BROWSE_URL) {
    this.apiKey = config.apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * One `/browse` request per kind of place, not one for all of them. A single
   * request with every category shares one `limit`, and around a busy stop the
   * nearest ten places are all truck stops and fuel: the weigh station and rest
   * area a driver actually needs are farther off and never make the cut. Asking
   * per kind guarantees each kind its own few results.
   *
   * Each place is labelled with the kind it was asked for as, not with whatever
   * HERE lists first for it (a fuel stop is often also tagged a truck stop). A
   * place returned under two kinds keeps the first in `NEARBY_STOP_CATEGORIES`'
   * order, so it is listed once.
   */
  async nearbyStops(lat: number, lng: number, radiusMeters: number): Promise<NearbyPlace[]> {
    const kinds = Object.entries(NEARBY_STOP_CATEGORIES) as Array<[NearbyStopCategory, { id: string; label: string }]>;

    const perKind = await Promise.all(
      kinds.map(async ([category, { id, label }]) => {
        const url = new URL(this.baseUrl);
        // `at` is required by `/browse` even when `in` already names the area:
        // without it HERE answers 400 "Required parameter 'at' is missing". Found
        // by trying it against the real API; the tests had only ever seen a
        // fake. It also makes HERE return each place's distance from that point,
        // which `distanceMiles` below reads.
        url.searchParams.set('at', `${lat},${lng}`);
        url.searchParams.set('in', `circle:${lat},${lng};r=${Math.round(radiusMeters)}`);
        url.searchParams.set('categories', id);
        url.searchParams.set('limit', String(RESULTS_PER_CATEGORY));
        // `apiKey`, capital K — the v7 Geocoding & Search convention `here-geocode.ts`
        // already uses, not v8 Routing's lowercase `apikey` in `here.ts`. `/browse`
        // is part of the same v7 API family as geocode, not routing.
        url.searchParams.set('apiKey', this.apiKey);

        const body = (await hereFetch(url)) as HereBrowseResponse;
        return (body.items ?? [])
          .filter((item) => item.position && item.title)
          .map(
            (item): NearbyPlace => ({
              name: item.title!,
              category,
              categoryLabel: label,
              lat: item.position!.lat,
              lng: item.position!.lng,
              distanceMiles: (item.distance ?? 0) / METERS_PER_MILE,
              address: item.address?.label ?? null,
            }),
          );
      }),
    );

    const seen = new Set<string>();
    const places: NearbyPlace[] = [];
    for (const place of perKind.flat()) {
      const key = `${place.name}|${place.lat.toFixed(5)}|${place.lng.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(place);
    }
    return places.sort((a, b) => a.distanceMiles - b.distanceMiles);
  }
}
