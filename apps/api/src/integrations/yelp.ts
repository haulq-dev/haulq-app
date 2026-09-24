/**
 * Yelp Fusion — Business Search, for nearby mechanics.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 3: the boss's own hedge on the call —
 * "could just be a normal AI search" — over building a persistent trust-
 * score pipeline. This is that smaller version: call Yelp at request time,
 * rank by what Yelp already returns, store nothing. HaulQ's Yelp account
 * allows only 300 calls a day in total (not the 5,000 first assumed), which is
 * enough to see whether carriers reach for this before committing to
 * scraping/aggregating reviews ourselves, and is why `routes/mechanics.ts`
 * caps each carrier's searches.
 *
 * Bearer-token auth rather than a query-string key — Yelp's own documented
 * scheme, unlike every HERE endpoint in this codebase — so this file gets
 * its own fetch helper rather than reusing `hereFetch`.
 */

const YELP_SEARCH_URL = 'https://api.yelp.com/v3/businesses/search';

const METERS_PER_MILE = 1609.344;
/** Yelp's own documented ceiling on `radius` — a larger value is rejected, not clamped. */
const YELP_MAX_RADIUS_METERS = 40_000;

export class YelpApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'YelpApiError';
    this.status = status;
  }
}

export interface YelpConfig {
  apiKey: string;
}

export interface Mechanic {
  name: string;
  /** 1–5, Yelp's own aggregate. Null when Yelp has not rated this business. */
  rating: number | null;
  reviewCount: number;
  address: string | null;
  phone: string | null;
  distanceMiles: number;
  /** The Yelp listing itself — where "why this rating" actually lives. */
  yelpUrl: string;
}

// --- wire shape ------------------------------------------------------
// Yelp's own /v3/businesses/search response, narrowed to the fields this
// file reads — same restraint `here.ts` and `here-places.ts` already apply
// to a response this codebase does not own the shape of.
interface YelpBusiness {
  name?: string;
  rating?: number;
  review_count?: number;
  display_phone?: string;
  distance?: number;
  url?: string;
  location?: { display_address?: string[] };
}

interface YelpSearchResponse {
  businesses?: YelpBusiness[];
}

export interface MechanicSearchProvider {
  /**
   * Repair shops matching `query` within `radiusMeters` of a point, in Yelp's
   * best-match order (not nearest first). `categories` is a comma-separated list
   * of Yelp category aliases that narrows what counts as a match; leave it out
   * and only the words in `query` decide.
   */
  nearbyMechanics(lat: number, lng: number, radiusMeters: number, query: string, categories?: string): Promise<Mechanic[]>;
}

export class YelpMechanicSearchProvider implements MechanicSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: YelpConfig, baseUrl: string = YELP_SEARCH_URL) {
    this.apiKey = config.apiKey;
    this.baseUrl = baseUrl;
  }

  async nearbyMechanics(lat: number, lng: number, radiusMeters: number, query: string, categories?: string): Promise<Mechanic[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lng));
    url.searchParams.set('radius', String(Math.min(Math.round(radiusMeters), YELP_MAX_RADIUS_METERS)));
    // Not a fixed "autorepair": tried against the real API, that hid every
    // towing company and tire shop (a "heavy duty towing" search returned
    // ordinary garages). The caller says what kind of business it wants.
    if (categories) url.searchParams.set('categories', categories);
    url.searchParams.set('term', query);
    // Yelp's own default is "best_match" — named explicitly rather than left
    // implicit, so a caller reading this file does not have to know Yelp's
    // default to know what order results come back in.
    url.searchParams.set('sort_by', 'best_match');
    url.searchParams.set('limit', '10');

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
      });
    } catch (err) {
      throw new YelpApiError(0, `Yelp unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new YelpApiError(response.status, `Yelp ${response.status}: ${text.slice(0, 500)}`);
    }

    const body = (await response.json()) as YelpSearchResponse;

    return (body.businesses ?? [])
      // Yelp treats `radius` as a hint: asked for 15 miles, it returned shops
      // 19 and 37 miles away when few matched. The screen says "within 15
      // miles", so hold it to that. A business with no distance is dropped
      // rather than assumed near.
      .filter((b) => b.name && b.distance !== undefined && b.distance <= radiusMeters)
      .map((b) => ({
        name: b.name!,
        rating: b.rating ?? null,
        reviewCount: b.review_count ?? 0,
        address: b.location?.display_address?.join(', ') ?? null,
        phone: b.display_phone || null,
        distanceMiles: (b.distance ?? 0) / METERS_PER_MILE,
        yelpUrl: b.url ?? '',
      }));
  }
}
