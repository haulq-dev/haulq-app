/**
 * Repair shops near the truck, a stop, or the phone itself, from Yelp.
 * Web's `NearbyMechanicsCard` (`apps/web/src/routes/LoadPlaces.tsx`) on a
 * phone (MOBILE_PARITY_PLAN.md M6), for both the office load screen and the
 * driver's. A driver broken down on the shoulder is who this is for, so the
 * driver version offers "Where I am now" first.
 *
 * **Yelp's display rules apply** (`public/yelp/NOTICE.txt`): Yelp's own logo,
 * unaltered, on anything from Yelp, linking to Yelp; ratings only as Yelp's
 * branded star images beside the review count; each business linking to its
 * Yelp page. The images are the same files web ships.
 *
 * **Every search is a Yelp call** against a shared daily budget (300/day,
 * plus a per-carrier limit), so nothing searches until the button is
 * tapped, and results are cached for ten minutes (`useNearbyMechanics`).
 */

import { Geolocation } from '@capacitor/geolocation';
import {
  DEFAULT_MECHANIC_RADIUS,
  formatMiles,
  MECHANIC_RADIUS_OPTIONS,
  MECHANIC_SEARCHES,
  telHref,
  useNearbyMechanics,
  yelpStarKey,
  type MechanicSearch,
  type SearchOrigin,
} from '@haulq/client';
import { useState } from 'react';
import { ApiRequestError } from '../lib/api.ts';
import { CoordinateLookup } from './CoordinateLookup.tsx';
import { Empty, ErrorNote, Field, Note } from './ui.tsx';

const code = (error: unknown) => (error instanceof ApiRequestError ? error.code : null);

function YelpMark({ height }: { height: number }) {
  return <img src="/yelp/yelp_logo.svg" alt="Yelp" style={{ height, width: 'auto' }} />;
}

function YelpStars({ rating, reviewCount }: { rating: number | null; reviewCount: number }) {
  const key = yelpStarKey(rating);
  if (key === null || rating === null) return <span className="text-sm text-mute">Not rated on Yelp</span>;
  const base = `/yelp/stars/Review_Ribbon_medium_20_${key}`;
  return (
    <span className="inline-flex items-center gap-2">
      <img
        src={`${base}@1x.png`}
        srcSet={`${base}@1x.png 1x, ${base}@2x.png 2x`}
        width={108}
        height={20}
        alt={`${rating.toFixed(1)} out of 5 stars on Yelp`}
      />
      <span className="num text-sm text-slate">
        {reviewCount} review{reviewCount === 1 ? '' : 's'}
      </span>
    </span>
  );
}

/**
 * `origins` are the load's known points (the truck's last position, stops
 * with coordinates). `nearMe` adds the phone's own location, first: a
 * driver's case. Without it, "Somewhere else" takes a city instead.
 */
export function RepairShops({ origins, nearMe = false }: { origins: SearchOrigin[]; nearMe?: boolean }) {
  const keys = [...(nearMe ? ['me'] : []), ...origins.map((o) => o.key), ...(nearMe ? [] : ['elsewhere'])];
  const [chosen, setChosen] = useState<string>(keys[0] ?? 'elsewhere');
  const [elsewhere, setElsewhere] = useState<{ city: string; state: string; lat: number | null; lng: number | null }>({
    city: '',
    state: '',
    lat: null,
    lng: null,
  });
  const [radius, setRadius] = useState<number>(DEFAULT_MECHANIC_RADIUS);
  const [preset, setPreset] = useState(0);
  const [search, setSearch] = useState<MechanicSearch | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const results = useNearbyMechanics(search);

  const what = MECHANIC_SEARCHES[preset]!;
  const fixed =
    chosen === 'elsewhere'
      ? elsewhere.lat !== null && elsewhere.lng !== null
        ? { lat: elsewhere.lat, lng: elsewhere.lng }
        : null
      : (origins.find((o) => o.key === chosen) ?? null);

  const run = async () => {
    setLocateError(null);
    let point = fixed;
    if (chosen === 'me') {
      setLocating(true);
      try {
        const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 15_000 });
        point = { lat: position.coords.latitude, lng: position.coords.longitude };
      } catch {
        setLocateError("Couldn't get your location. Check that HaulQ is allowed to use it, or pick a stop instead.");
        return;
      } finally {
        setLocating(false);
      }
    }
    if (!point) return;
    setSearch({ lat: point.lat, lng: point.lng, radiusMiles: radius, query: what.query, categories: what.categories });
  };

  // The two daily limits are expected, dated states, so they read as a note
  // carrying the API's own sentence about which one and when it resets.
  const limitReached = code(results.error) === 'org_search_limit_reached' || code(results.error) === 'search_limit_reached';
  const unavailable =
    code(results.error) === 'not_configured'
      ? "Repair-shop search isn't connected on this deployment yet."
      : limitReached && results.error instanceof ApiRequestError
        ? results.error.explanation
        : null;

  return (
    <div className="space-y-3">
      <Field label="Near">
        <select className="hq-input" value={chosen} onChange={(e) => setChosen(e.target.value)}>
          {nearMe && <option value="me">Where I am now</option>}
          {origins.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
          {!nearMe && <option value="elsewhere">Somewhere else…</option>}
        </select>
      </Field>

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

      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Looking for">
        {MECHANIC_SEARCHES.map((s, i) => (
          <button
            key={s.query}
            type="button"
            role="radio"
            aria-checked={preset === i}
            onClick={() => setPreset(i)}
            className={`hq-pill px-3 py-1.5 text-[0.8125rem] ${preset === i ? 'bg-ink text-white' : 'bg-wash text-slate'}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <Field label="Within">
        <select className="hq-input" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
          {MECHANIC_RADIUS_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r} miles
            </option>
          ))}
        </select>
      </Field>

      <button
        type="button"
        className="hq-btn hq-btn-brand w-full"
        disabled={(chosen !== 'me' && !fixed) || locating || results.isFetching}
        onClick={() => void run()}
      >
        {locating ? 'Finding you…' : results.isFetching ? 'Searching…' : 'Find shops'}
      </button>

      {locateError && <Note>{locateError}</Note>}
      {unavailable ? <Note>{unavailable}</Note> : <ErrorNote error={results.error} />}

      {results.data &&
        (results.data.mechanics.length === 0 ? (
          <Empty>No shops found within {search?.radiusMiles} miles. Try a wider search.</Empty>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {results.data.mechanics.map((m, i) => {
                const tel = telHref(m.phone);
                return (
                  <li key={`${m.name}-${i}`} className="space-y-1 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="font-semibold">{m.name}</p>
                      <span className="num shrink-0 text-xs text-mute">{formatMiles(m.distanceMiles)}</span>
                    </div>
                    <YelpStars rating={m.rating} reviewCount={m.reviewCount} />
                    {m.address && <p className="text-xs text-mute">{m.address}</p>}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm">
                      {tel && m.phone && (
                        <a href={tel} className="hq-btn hq-btn-primary px-3 py-1.5 text-sm active:scale-100">
                          Call {m.phone}
                        </a>
                      )}
                      <a href={m.yelpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-brand underline">
                        Reviews on <YelpMark height={16} />
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="flex items-center gap-2 text-xs text-mute">
              Ratings and reviews from
              <a href="https://www.yelp.com" target="_blank" rel="noreferrer" className="inline-flex items-center">
                <YelpMark height={20} />
              </a>
            </p>
          </>
        ))}
    </div>
  );
}
