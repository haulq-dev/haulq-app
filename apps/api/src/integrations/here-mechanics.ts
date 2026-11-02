/**
 * HERE Geocoding & Search API v7 — nearby repair shops.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 3: call a vendor at request time, return
 * what it says, store nothing. This replaced Yelp Fusion on 2026-11-02, when its
 * trial ended and its cheapest plan ($229 a month) was too much for a feature
 * still finding out whether carriers use it. Same HERE account `here-places.ts`
 * already holds a key for. HERE has no ratings or reviews, so neither does this.
 *
 * Two endpoints, because they answer differently, tried against the real API on
 * 2026-11-02. `/browse` by category is what the shortcuts use: 20 truck repair
 * shops around Chicago or Amarillo, 5 around rural Nebraska. `/discover` is what
 * a typed search uses, and only ever finds a few: "semi truck tires" found none
 * in any of the three places. Asked with `at` alone rather than a circle, it
 * returned shops over 1,000 miles away. HERE's tire category also holds some
 * noise (a bike shop in Chicago); that is HERE's data.
 */

import { hereFetch, type HereConfig } from './here.ts';

const HERE_BROWSE_URL = 'https://browse.search.hereapi.com/v1/browse';
const HERE_DISCOVER_URL = 'https://discover.search.hereapi.com/v1/discover';

/** More than is returned, so duplicates do not shorten the list. */
const RESULTS_REQUESTED = 20;
const RESULTS_RETURNED = 10;

/**
 * The kinds of business a caller can ask for, with HERE's own category IDs from
 * docs.here.com/geocoding-and-search/docs/places-category-system-full, checked
 * there on 2026-11-02. `autorepair` and `trailerrepair` are deliberately absent:
 * see `hereCategoryIds`.
 */
const HERE_CATEGORY_IDS: Record<string, string> = {
  truckrepair: '700-7850-0126',
  tires: '700-7850-0125',
  towing: '700-7200-0278',
};

/**
 * Which HERE categories a `categories` list means, or none for a search the words
 * should decide. The iOS builds already installed send Yelp's lists
 * (`truckrepair,autorepair` and `trailerrepair,truckrepair`), so those keep
 * working: `autorepair` is ignored, since HERE's car repair category is ordinary
 * garages, and HERE has no trailer repair category, so `trailerrepair` falls
 * through to the words, which do find trailer shops.
 */
function hereCategoryIds(categories: string | undefined): string[] {
  const kinds = categories?.split(',') ?? [];
  if (kinds.includes('trailerrepair')) return [];
  return kinds.flatMap((kind) => HERE_CATEGORY_IDS[kind] ?? []);
}

const METERS_PER_MILE = 1609.344;

export interface Mechanic {
  name: string;
  address: string | null;
  phone: string | null;
  distanceMiles: number;
  lat: number;
  lng: number;
}

// --- wire shape ------------------------------------------------------
// HERE's own response, narrowed to the fields this file reads.
interface HereShopItem {
  title?: string;
  position?: { lat: number; lng: number };
  distance?: number;
  address?: { label?: string };
  contacts?: Array<{ phone?: Array<{ value?: string }> }>;
}

interface HereShopResponse {
  items?: HereShopItem[];
}

export interface MechanicSearchProvider {
  /**
   * Repair shops within `radiusMeters` of a point, closest first. `categories`
   * is a comma-separated list of the kinds of business in `HERE_CATEGORY_IDS`;
   * leave it out and only the words in `query` decide.
   */
  nearbyMechanics(lat: number, lng: number, radiusMeters: number, query: string, categories?: string): Promise<Mechanic[]>;
}

/** HERE sends "+13165550100". Anything that is not a US number is left as it came. */
function displayPhone(value: string | undefined): string | null {
  if (!value) return null;
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : value;
}

export class HereMechanicSearchProvider implements MechanicSearchProvider {
  private readonly apiKey: string;
  private readonly browseUrl: string;
  private readonly discoverUrl: string;

  constructor(config: HereConfig, browseUrl: string = HERE_BROWSE_URL, discoverUrl: string = HERE_DISCOVER_URL) {
    this.apiKey = config.apiKey;
    this.browseUrl = browseUrl;
    this.discoverUrl = discoverUrl;
  }

  async nearbyMechanics(lat: number, lng: number, radiusMeters: number, query: string, categories?: string): Promise<Mechanic[]> {
    const ids = hereCategoryIds(categories);
    const url = new URL(ids.length > 0 ? this.browseUrl : this.discoverUrl);
    url.searchParams.set('in', `circle:${lat},${lng};r=${Math.round(radiusMeters)}`);
    if (ids.length > 0) {
      // `/browse` requires `at` even with a circle: see `here-places.ts`.
      url.searchParams.set('at', `${lat},${lng}`);
      url.searchParams.set('categories', ids.join(','));
    } else {
      url.searchParams.set('q', query);
    }
    url.searchParams.set('limit', String(RESULTS_REQUESTED));
    url.searchParams.set('apiKey', this.apiKey);

    const body = (await hereFetch(url)) as HereShopResponse;

    // HERE lists some shops twice (Amarillo's "Chihuahua Truck Repair" came back
    // as two records at one spot), so the same name and phone is one shop, kept
    // at its nearest. A business with no distance or position is dropped rather
    // than assumed near.
    const seen = new Set<string>();
    const mechanics: Mechanic[] = [];
    const nearestFirst = (body.items ?? [])
      .filter((item) => item.title && item.position && item.distance !== undefined && item.distance <= radiusMeters)
      .sort((a, b) => a.distance! - b.distance!);
    for (const item of nearestFirst) {
      const phone = displayPhone(item.contacts?.flatMap((c) => c.phone ?? [])[0]?.value);
      const key = `${item.title!.toLowerCase()}|${phone ?? `${item.position!.lat.toFixed(3)},${item.position!.lng.toFixed(3)}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mechanics.push({
        name: item.title!,
        address: item.address?.label ?? null,
        phone,
        distanceMiles: item.distance! / METERS_PER_MILE,
        lat: item.position!.lat,
        lng: item.position!.lng,
      });
    }
    return mechanics.slice(0, RESULTS_RETURNED);
  }
}
