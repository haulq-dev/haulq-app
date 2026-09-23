/**
 * A load's stops after it exists: correcting coordinates and appointment
 * windows (web's `EditLoadStops`), and what's near each stop (HaulQ Routes'
 * nearby stops, which had an API and no screen anywhere until now).
 * Owners and dispatchers only.
 */

import { useMutation } from '@tanstack/react-query';
import { toDatetimeLocal, useNearbyStops, type Load, type Stop } from '@haulq/client';
import { useState } from 'react';
import { ApiRequestError, request } from '../../lib/api.ts';
import { CoordinateLookup } from '../../components/CoordinateLookup.tsx';
import { ErrorNote, Field, Note } from '../../components/ui.tsx';
import { Section, useRefreshLoad } from './shared.tsx';

const bySeq = (stops: Stop[]) => [...stops].sort((a, b) => a.seq - b.seq);

export function EditStopsSection({ load }: { load: Load }) {
  const missing = load.stops.filter((s) => s.lat === null || s.lng === null).length;
  return (
    <Section
      title="Stops"
      summary={missing ? `${missing} ${missing === 1 ? 'needs' : 'need'} coordinates` : `${load.stops.length} stops`}
    >
      <p className="text-sm text-slate">
        Coordinates and appointment windows are what a feasibility check reads. A stop with a city and state finds
        its coordinates on its own.
      </p>
      {bySeq(load.stops).map((stop) => (
        <StopEditor key={stop.id} load={load} stop={stop} />
      ))}
    </Section>
  );
}

/**
 * One stop, saved on its own, because `updateLoadStop` is per stop.
 * Coordinates save as a pair: a lat with no lng is half a location, and
 * feasibility would treat it as missing anyway.
 */
function StopEditor({ load, stop }: { load: Load; stop: Stop }) {
  const refresh = useRefreshLoad(load.id);
  const [v, setV] = useState({
    lat: stop.lat !== null ? String(stop.lat) : '',
    lng: stop.lng !== null ? String(stop.lng) : '',
    windowStart: toDatetimeLocal(stop.windowStart),
    windowEnd: toDatetimeLocal(stop.windowEnd),
  });
  const mismatched = Boolean(v.lat) !== Boolean(v.lng);

  const save = useMutation({
    mutationFn: () =>
      request(`/v1/loads/${load.id}/stops/${stop.id}`, {
        method: 'PATCH',
        body: {
          lat: v.lat && v.lng ? Number(v.lat) : null,
          lng: v.lat && v.lng ? Number(v.lng) : null,
          windowStart: v.windowStart ? new Date(v.windowStart).toISOString() : null,
          windowEnd: v.windowEnd ? new Date(v.windowEnd).toISOString() : null,
        },
      }),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-3 rounded-[var(--radius-sm)] bg-wash p-3">
      <p className="text-sm font-medium">
        <span className="field-label text-brand">{stop.type === 'pickup' ? 'Pickup' : 'Delivery'} </span>
        {stop.city}, {stop.state}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Lat">
          <input className="hq-input" inputMode="decimal" value={v.lat} onChange={(e) => setV({ ...v, lat: e.target.value })} />
        </Field>
        <Field label="Lng">
          <input className="hq-input" inputMode="decimal" value={v.lng} onChange={(e) => setV({ ...v, lng: e.target.value })} />
        </Field>
      </div>
      {stop.city && stop.state.length === 2 && (
        <CoordinateLookup
          address={{
            ...(stop.addressLine1 ? { addressLine1: stop.addressLine1 } : {}),
            city: stop.city,
            state: stop.state,
            ...(stop.postalCode ? { postalCode: stop.postalCode } : {}),
          }}
          hasCoordinates={Boolean(v.lat && v.lng)}
          onPick={(c) => setV((prev) => ({ ...prev, lat: String(c.lat), lng: String(c.lng) }))}
        />
      )}
      <Field label="Window opens">
        <input className="hq-input" type="datetime-local" value={v.windowStart} onChange={(e) => setV({ ...v, windowStart: e.target.value })} />
      </Field>
      <Field label="Window closes">
        <input className="hq-input" type="datetime-local" value={v.windowEnd} onChange={(e) => setV({ ...v, windowEnd: e.target.value })} />
      </Field>
      <div className="flex items-center gap-3">
        <button type="button" className="hq-btn hq-btn-primary" disabled={mismatched || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save stop'}
        </button>
        {mismatched && <span className="text-xs text-warn">Fill both lat and lng, or clear both.</span>}
        {save.isSuccess && !save.isPending && <span className="text-sm text-ok">Saved</span>}
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}

/**
 * Truck stops, scales, rest areas and fuel near each stop. Fetched only when
 * asked for, because each call is a live HERE lookup per stop. A place opens
 * in Apple Maps: a link outside the app's allowed navigation leaves the
 * WebView for the system.
 */
export function NearbyStopsSection({ load }: { load: Load }) {
  const [asked, setAsked] = useState(false);
  const nearby = useNearbyStops(load.id, asked);
  const notConfigured = nearby.error instanceof ApiRequestError && nearby.error.code === 'not_configured';

  return (
    <Section title="Nearby truck stops">
      {!asked ? (
        <>
          <p className="text-sm text-slate">Truck stops, weigh stations, rest areas and fuel within 10 miles of each stop.</p>
          <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setAsked(true)}>
            Look up
          </button>
        </>
      ) : nearby.isLoading ? (
        <p className="text-sm text-mute">Looking…</p>
      ) : notConfigured ? (
        <Note>Place search isn't connected on this deployment yet.</Note>
      ) : nearby.error ? (
        <ErrorNote error={nearby.error} />
      ) : (
        nearby.data?.stops.map((s) => (
          <div key={s.seq} className="space-y-1.5">
            <p className="field-label">
              Stop {s.seq}: {s.city}, {s.state}
            </p>
            {s.places.length === 0 ? (
              <p className="text-sm text-mute">Nothing found, or this stop has no coordinates yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {s.places.map((p, i) => (
                  <li key={i}>
                    <a
                      href={`https://maps.apple.com/?q=${encodeURIComponent(p.name)}&ll=${p.lat},${p.lng}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-baseline justify-between gap-3 py-2"
                    >
                      <span>
                        <span className="block text-sm">{p.name}</span>
                        <span className="block text-xs text-mute">{p.categoryLabel}</span>
                      </span>
                      <span className="num shrink-0 text-xs text-mute">{p.distanceMiles.toFixed(1)} mi</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </Section>
  );
}
