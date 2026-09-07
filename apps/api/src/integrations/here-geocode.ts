/**
 * HERE Geocoding & Search API v7 — forward and reverse.
 *
 * Same account, same key, same `fetch`-following shape as `here.ts` — see
 * that file's module note. Two separate interfaces (`Geocoder`,
 * `ReverseGeocoder`) rather than one, for the same reason this file is
 * already separate from `HereRoutingProvider`: `/v1/geocode` (address ->
 * coordinates, a dispatcher confirming a stop) and the check-in position
 * ping (coordinates -> city/state, nobody confirms anything) are different
 * capabilities with different consumers, and folding them into one
 * interface would force `geocode.test.ts`'s `FakeGeocoder` to implement a
 * reverse lookup it has nothing to do with. `HereGeocoder` implements both
 * because in production they really are the same HERE account — the
 * separation is for consumers, not for HERE.
 *
 * Written against HERE's published v7 Geocode/Reverse Geocode request/
 * response shape (`q=` vs `at=`, `items[].position`, `items[].address`),
 * same "validate before trusting" caveat `here.ts`'s own module note
 * carries — run this file's tests against a real response the first time
 * either direction is exercised live.
 */

import { hereFetch, type HereConfig } from './here.ts';

const HERE_GEOCODE_URL = 'https://geocode.search.hereapi.com/v1/geocode';
const HERE_REVGEOCODE_URL = 'https://revgeocode.search.hereapi.com/v1/revgeocode';

/** How many alternates a dispatcher sees for one query — enough to spot an ambiguous match, not so many the list stops being scannable. */
const MAX_CANDIDATES = 3;

export interface GeocodeCandidate {
  /** HERE's own resolved address string — what the dispatcher confirms against. */
  label: string;
  lat: number;
  lng: number;
  /** HERE's `scoring.queryScore`, 0 to 1 — how well the match fits what was typed, not a confidence in the coordinates themselves. */
  score: number;
}

/** Nulls, not omitted fields — a truck's position can be genuinely resolved with no city name HERE will give up (rural coordinates), and the caller needs to tell that apart from "never looked up." */
export interface ReverseGeocodeResult {
  city: string | null;
  state: string | null;
}

// --- wire shape ----------------------------------------------------------
// HERE's own v7 response, narrowed to the fields this file reads. Everything
// else is dropped rather than modeled, same restraint `here.ts` uses for
// its own routing response. One shape serves both directions — HERE's
// forward and reverse geocode responses share the same `items[].address`
// object.
interface HereGeocodeResponse {
  items?: Array<{
    address?: { label?: string; city?: string; stateCode?: string; state?: string };
    position?: { lat: number; lng: number };
    scoring?: { queryScore?: number };
  }>;
}

/**
 * Separate from `HereGeocoder` for the same reason `RoutingProvider` is
 * separate from `HereRoutingProvider` — so a test can inject a fake with no
 * HERE account, the way `feasibility.test.ts`'s `FakeRoutingProvider` does.
 */
export interface Geocoder {
  geocode(query: string): Promise<GeocodeCandidate[]>;
}

/** See this file's module note for why this is a separate interface from `Geocoder`. */
export interface ReverseGeocoder {
  reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult>;
}

export class HereGeocoder implements Geocoder, ReverseGeocoder {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly revgeocodeBaseUrl: string;

  constructor(
    config: HereConfig,
    baseUrl: string = HERE_GEOCODE_URL,
    revgeocodeBaseUrl: string = HERE_REVGEOCODE_URL,
  ) {
    this.apiKey = config.apiKey;
    this.baseUrl = baseUrl;
    this.revgeocodeBaseUrl = revgeocodeBaseUrl;
  }

  async geocode(query: string): Promise<GeocodeCandidate[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(MAX_CANDIDATES));
    url.searchParams.set('apiKey', this.apiKey);

    const body = (await hereFetch(url)) as HereGeocodeResponse;

    return (body.items ?? [])
      .filter((item) => item.position && item.address?.label)
      .map((item) => ({
        label: item.address!.label!,
        lat: item.position!.lat,
        lng: item.position!.lng,
        score: item.scoring?.queryScore ?? 0,
      }));
  }

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    const url = new URL(this.revgeocodeBaseUrl);
    url.searchParams.set('at', `${lat},${lng}`);
    url.searchParams.set('limit', '1');
    url.searchParams.set('apiKey', this.apiKey);

    const body = (await hereFetch(url)) as HereGeocodeResponse;
    const address = body.items?.[0]?.address;

    return {
      city: address?.city ?? null,
      // `stateCode` is the two-letter form the rest of this app already
      // stores (see `routes/geocode.ts`'s `state: z.string().length(2)`) —
      // fall back to the full name only on the rare item that has one but
      // not the other, rather than losing the state entirely.
      state: address?.stateCode ?? address?.state ?? null,
    };
  }
}
