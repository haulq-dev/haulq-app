/**
 * HERE Geocoding & Search API v7.
 *
 * Same account, same key, same `fetch`-following shape as `here.ts` — see
 * that file's module note. A separate class rather than a method on
 * `HereRoutingProvider` because this is a different HERE endpoint
 * (`geocode.search.hereapi.com`, not `router.hereapi.com`) and a logically
 * separate capability: `RoutingProvider` describes "give me a route between
 * coordinates," and folding geocoding into it would force every consumer of
 * that interface — including the test double in `routes/feasibility.test.ts`
 * — to implement a method it has nothing to do with.
 *
 * Written against HERE's published v7 Geocode request/response shape
 * (`q=`, `items[].position`, `items[].address.label`,
 * `items[].scoring.queryScore`), same "validate before trusting" caveat
 * `here.ts`'s own module note carries — run `here-geocode.test.ts`'s
 * fixtures against a real response the first time this is exercised live.
 */

import { hereFetch, type HereConfig } from './here.ts';

const HERE_GEOCODE_URL = 'https://geocode.search.hereapi.com/v1/geocode';

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

// --- wire shape ----------------------------------------------------------
// HERE's own v7 response, narrowed to the fields this file reads. Everything
// else is dropped rather than modeled, same restraint `here.ts` uses for
// its own routing response.
interface HereGeocodeResponse {
  items?: Array<{
    address?: { label?: string };
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

export class HereGeocoder implements Geocoder {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: HereConfig, baseUrl: string = HERE_GEOCODE_URL) {
    this.apiKey = config.apiKey;
    this.baseUrl = baseUrl;
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
}
