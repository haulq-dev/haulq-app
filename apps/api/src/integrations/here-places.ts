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

/** Enough to show a real choice at a stop without turning into a directory. */
const MAX_RESULTS = 10;

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

  async nearbyStops(lat: number, lng: number, radiusMeters: number): Promise<NearbyPlace[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('in', `circle:${lat},${lng};r=${Math.round(radiusMeters)}`);
    url.searchParams.set(
      'categories',
      Object.values(NEARBY_STOP_CATEGORIES)
        .map((c) => c.id)
        .join(','),
    );
    url.searchParams.set('limit', String(MAX_RESULTS));
    // `apiKey`, capital K — the v7 Geocoding & Search convention `here-geocode.ts`
    // already uses, not v8 Routing's lowercase `apikey` in `here.ts`. `/browse`
    // is part of the same v7 API family as geocode, not routing.
    url.searchParams.set('apiKey', this.apiKey);

    const body = (await hereFetch(url)) as HereBrowseResponse;

    return (body.items ?? [])
      .filter((item) => item.position && item.title)
      .map((item) => {
        const categoryId = item.categories?.[0]?.id;
        const entry = (Object.entries(NEARBY_STOP_CATEGORIES) as Array<
          [NearbyStopCategory, { id: string; label: string }]
        >).find(([, c]) => c.id === categoryId);

        return {
          name: item.title!,
          // Falls back to `truckStop` on a category HERE returns that this
          // file did not ask for — should not happen given the `categories`
          // filter above, but a silent `undefined` is worse than a labeled
          // guess a reviewer can spot in a response.
          category: entry?.[0] ?? 'truckStop',
          categoryLabel: entry?.[1].label ?? NEARBY_STOP_CATEGORIES.truckStop.label,
          lat: item.position!.lat,
          lng: item.position!.lng,
          distanceMiles: (item.distance ?? 0) / METERS_PER_MILE,
          address: item.address?.label ?? null,
        };
      })
      .sort((a, b) => a.distanceMiles - b.distanceMiles);
  }
}
