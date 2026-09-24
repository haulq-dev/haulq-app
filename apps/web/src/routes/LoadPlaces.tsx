/**
 * Two lookups on a load that had an API and no screen: what is near its stops,
 * and who could fix a truck near where it is.
 * `FEATURE_REQUESTS_PLAN.md` sections 3 and 4.
 *
 * Both are live searches against a vendor (HERE for stops, Yelp for shops) and
 * store nothing, so neither runs until asked. Where a vendor is not connected on
 * this deployment, or the carrier's plan does not include the product, that is
 * said plainly as an expected state rather than raised as an error.
 */

import {
  DEFAULT_MECHANIC_RADIUS,
  DEFAULT_STOP_RADIUS,
  formatMiles,
  formatRating,
  groupPlaces,
  mapsUrl,
  MECHANIC_RADIUS_OPTIONS,
  MECHANIC_SEARCHES,
  searchOrigins,
  STOP_RADIUS_OPTIONS,
  telHref,
  tidyAddress,
  useLoadTracking,
  useNearbyMechanics,
  useNearbyStops,
  type Load,
  type MechanicSearch,
} from '@haulq/client';
import { useState } from 'react';
import { Card, Empty, ErrorNote } from '../components/ui.tsx';
import { ApiRequestError } from '../lib/api.ts';
import { CoordinateLookup } from './Loads.tsx';

/** A state the carrier cannot do anything about, said calmly: no alert styling. */
function ExpectedNote({ children }: { children: React.ReactNode }) {
  return <p className="border-l-2 border-line bg-wash px-3 py-2 text-sm text-mute">{children}</p>;
}

const code = (error: unknown) => (error instanceof ApiRequestError ? error.code : null);

// --- nearby stops -------------------------------------------------------------------

/**
 * Truck stops, weigh stations, rest areas, washes and fuel around each stop.
 * HaulQ Routes, so Fleet only; a Core carrier is told, not shown an error.
 */
export function NearbyStopsCard({ load }: { load: Load }) {
  const [asked, setAsked] = useState(false);
  const [radius, setRadius] = useState<number>(DEFAULT_STOP_RADIUS);
  const nearby = useNearbyStops(load.id, asked, radius);

  const unavailable =
    code(nearby.error) === 'not_configured'
      ? 'Place search is not connected on this deployment yet.'
      : code(nearby.error) === 'not_entitled'
        ? 'Nearby stops are part of HaulQ Routes, which is on the Fleet plan.'
        : null;

  return (
    <Card title={`Load ${load.reference} — nearby stops`}>
      <p className="mb-3 max-w-prose text-sm text-slate">
        Truck stops, fuel, rest areas, weigh stations and washes around each stop on this load. Where a place is, not whether it has room.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-slate">
          Within
          <select className="hq-input w-auto py-1 text-sm" value={radius} onChange={(e) => setRadius(Number(e.target.value))} aria-label="Search radius">
            {STOP_RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r} miles
              </option>
            ))}
          </select>
        </label>
        {!asked && (
          <button type="button" className="hq-btn hq-btn-brand" onClick={() => setAsked(true)}>
            Look up
          </button>
        )}
      </div>

      {asked && nearby.isLoading && <p className="text-sm text-mute">Looking…</p>}
      {unavailable ? <ExpectedNote>{unavailable}</ExpectedNote> : <ErrorNote error={nearby.error} />}

      {nearby.data && (
        <div className="space-y-5">
          {nearby.data.stops.map((stop) => {
            const source = load.stops.find((s) => s.seq === stop.seq);
            const noCoordinates = source ? source.lat === null || source.lng === null : false;
            const groups = groupPlaces(stop.places);
            return (
              <section key={stop.seq} aria-label={`Stop ${stop.seq}`}>
                <h3 className="field-label mb-2 text-ink">
                  {source ? (source.type === 'pickup' ? 'Pickup' : 'Delivery') : `Stop ${stop.seq}`}: {stop.city}, {stop.state}
                </h3>
                {groups.length === 0 ? (
                  <p className="text-sm text-mute">
                    {noCoordinates
                      ? 'This stop has no coordinates yet, so there is nothing to search around. Add them under Stops above.'
                      : `Nothing found within ${radius} miles.`}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {groups.map((g) => (
                      <div key={g.category}>
                        <p className="field-label mb-1 text-mute">{g.label}</p>
                        <ul className="divide-y divide-line border-y border-line">
                          {g.places.map((p, i) => (
                            <li key={`${p.name}-${i}`} className="flex items-baseline justify-between gap-3 py-2">
                              <span>
                                <a href={mapsUrl(p)} target="_blank" rel="noreferrer" className="text-sm text-brand underline">
                                  {p.name}
                                </a>
                                {tidyAddress(p.name, p.address) && <span className="block text-xs text-mute">{tidyAddress(p.name, p.address)}</span>}
                              </span>
                              <span className="num shrink-0 text-xs text-mute">{formatMiles(p.distanceMiles)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// --- nearby repair shops ---------------------------------------------------------------

/**
 * Repair shops near where the truck is, near a stop, or near somewhere else. The
 * starting point matters more than the search: a breakdown is about where the
 * truck is now, which a dispatcher does not always want to type out.
 *
 * Reviews are Yelp's, shown as Yelp's, each linking back to its Yelp page.
 */
export function NearbyMechanicsCard({ load }: { load: Load }) {
  const tracking = useLoadTracking(load.id);
  const origins = searchOrigins({ truck: tracking.data?.truck, stops: load.stops });

  const [originKey, setOriginKey] = useState<string | null>(null);
  const chosen = originKey ?? origins[0]?.key ?? 'elsewhere';
  const [elsewhere, setElsewhere] = useState<{ city: string; state: string; lat: number | null; lng: number | null }>({
    city: '',
    state: '',
    lat: null,
    lng: null,
  });
  const [radius, setRadius] = useState<number>(DEFAULT_MECHANIC_RADIUS);
  const [query, setQuery] = useState<string>(MECHANIC_SEARCHES[0]!.query);
  // The kind of business, when a shortcut chose it. Typing over the words
  // drops it: a search someone wrote themselves is decided by their words.
  const [categories, setCategories] = useState<string | undefined>(MECHANIC_SEARCHES[0]!.categories);
  const [search, setSearch] = useState<MechanicSearch | null>(null);
  const results = useNearbyMechanics(search);

  const origin =
    chosen === 'elsewhere'
      ? elsewhere.lat !== null && elsewhere.lng !== null
        ? { lat: elsewhere.lat, lng: elsewhere.lng }
        : null
      : (origins.find((o) => o.key === chosen) ?? null);

  // Two daily limits (this carrier's, and HaulQ's Yelp budget as a whole) are
  // expected states with a date on them, so they read as a note, and the
  // API's own sentence says which one and when it starts over.
  const limitReached = code(results.error) === 'org_search_limit_reached' || code(results.error) === 'search_limit_reached';
  const unavailable =
    code(results.error) === 'not_configured'
      ? 'Repair-shop search is not connected on this deployment yet.'
      : limitReached && results.error instanceof ApiRequestError
        ? results.error.explanation
        : null;

  return (
    <Card title={`Load ${load.reference} — nearby repair shops`}>
      <p className="mb-3 max-w-prose text-sm text-slate">Find a shop near the truck, a stop, or anywhere else. Ratings and reviews come from Yelp.</p>

      <div className="space-y-3">
        <label className="block">
          <span className="field-label mb-1.5 block text-slate">Search near</span>
          <select className="hq-input" value={chosen} onChange={(e) => setOriginKey(e.target.value)}>
            {origins.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
            <option value="elsewhere">Somewhere else…</option>
          </select>
        </label>

        {chosen === 'elsewhere' && (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <input
                className="hq-input"
                aria-label="City"
                placeholder="City"
                value={elsewhere.city}
                onChange={(e) => setElsewhere({ city: e.target.value, state: elsewhere.state, lat: null, lng: null })}
              />
              <input
                className="hq-input uppercase"
                aria-label="State"
                placeholder="ST"
                maxLength={2}
                value={elsewhere.state}
                onChange={(e) => setElsewhere({ city: elsewhere.city, state: e.target.value.toUpperCase(), lat: null, lng: null })}
              />
            </div>
            <CoordinateLookup
              address={{ city: elsewhere.city, state: elsewhere.state }}
              hasCoordinates={elsewhere.lat !== null}
              onPick={(c) => setElsewhere((prev) => ({ ...prev, lat: c.lat, lng: c.lng }))}
            />
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="field-label mb-1.5 block text-slate">Looking for</span>
            <input className="hq-input" value={query} maxLength={100} onChange={(e) => {
                setQuery(e.target.value);
                setCategories(undefined);
              }}
            />
          </label>
          <label>
            <span className="field-label mb-1.5 block text-slate">Within</span>
            <select className="hq-input w-auto" value={radius} onChange={(e) => setRadius(Number(e.target.value))} aria-label="Search radius">
              {MECHANIC_RADIUS_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r} miles
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {MECHANIC_SEARCHES.map((s) => (
            <button key={s.query} type="button" className="hq-btn hq-btn-ghost px-2 py-1 text-xs" onClick={() => {
                setQuery(s.query);
                setCategories(s.categories);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="hq-btn hq-btn-brand"
          disabled={!origin || query.trim() === '' || results.isFetching}
          onClick={() => origin && setSearch({ lat: origin.lat, lng: origin.lng, radiusMiles: radius, query: query.trim(), categories })}
        >
          {results.isFetching ? 'Searching…' : 'Find shops'}
        </button>
        {chosen === 'elsewhere' && !origin && <p className="text-xs text-mute">Enter a city and state, and it finds the spot to search from.</p>}
      </div>

      <div className="mt-4">
        {unavailable ? <ExpectedNote>{unavailable}</ExpectedNote> : <ErrorNote error={results.error} />}

        {results.data &&
          (results.data.mechanics.length === 0 ? (
            <Empty>No shops found within {search?.radiusMiles} miles. Try a wider search.</Empty>
          ) : (
            <>
              <ul className="divide-y divide-line border-y border-line">
                {results.data.mechanics.map((m, i) => {
                  const tel = telHref(m.phone);
                  return (
                    <li key={`${m.name}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                      <div className="min-w-0">
                        <p className="font-semibold">{m.name}</p>
                        <p className="num text-sm text-slate">{formatRating(m)}</p>
                        {m.address && <p className="text-xs text-mute">{m.address}</p>}
                        <p className="mt-1 flex flex-wrap gap-x-4 text-sm">
                          {tel && m.phone && (
                            <a href={tel} className="text-brand underline">
                              {m.phone}
                            </a>
                          )}
                          <a href={m.yelpUrl} target="_blank" rel="noreferrer" className="text-brand underline">
                            View on Yelp
                          </a>
                        </p>
                      </div>
                      <span className="num shrink-0 text-xs text-mute">{formatMiles(m.distanceMiles)}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-mute">Ratings and reviews are from Yelp.</p>
            </>
          ))}
      </div>
    </Card>
  );
}
