/**
 * Add a load. Everything web's `AddLoad` form takes, plus a driver picker,
 * which web's form lacks (MOBILE_PARITY_PLAN.md M1).
 *
 * The driver picker matters here: a load assigned to nobody never reaches a
 * driver's own list (`driverScopeFor` in `apps/api/src/routes/loads.ts`
 * matches on `loads.driverId`), and a position ping needs a truck or it 422s
 * (`no_truck`).
 *
 * Only a city and two-letter state per stop are required, the same minimum
 * as web (`StopBase` in `@haulq/contracts`). Everything else is optional and
 * grouped so the required part is what you see first. Coordinates fill in
 * on their own (`CoordinateLookup`), and the delivery appointment is what
 * lets HaulQ Routes call a late arrival infeasible.
 *
 * Money is typed in dollars and sent in cents (build plan section 5: never
 * floats near an invoice).
 */

import { canTransition, LOAD_STATUSES, type LoadStatus } from '@haulq/contracts';
import { prettyStatus, queryKeys, useDrivers, useTrucks } from '@haulq/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { CoordinateLookup } from '../components/CoordinateLookup.tsx';
import { Card, ErrorNote, Field } from '../components/ui.tsx';
import { request } from '../lib/api.ts';

interface StopDraft {
  city: string;
  state: string;
  addressLine1: string;
  postalCode: string;
  lat: string;
  lng: string;
}

const emptyStop: StopDraft = { city: '', state: '', addressLine1: '', postalCode: '', lat: '', lng: '' };

/** The statuses a brand-new load can start at. Cancelled is never a starting point. */
const START_STATUSES = LOAD_STATUSES.filter((s) => s !== 'cancelled' && canTransition('prospect', s).allowed);

const numberOrNothing = (v: string) => (v.trim() ? Number(v) : undefined);

function stopBody(type: 'pickup' | 'delivery', s: StopDraft) {
  return {
    type,
    city: s.city.trim(),
    state: s.state,
    ...(s.addressLine1.trim() ? { addressLine1: s.addressLine1.trim() } : {}),
    ...(s.postalCode.trim() ? { postalCode: s.postalCode.trim() } : {}),
    ...(s.lat && s.lng ? { lat: Number(s.lat), lng: Number(s.lng) } : {}),
  };
}

export function CreateLoadScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trucks = useTrucks();
  const drivers = useDrivers();

  const [pickup, setPickup] = useState<StopDraft>(emptyStop);
  const [delivery, setDelivery] = useState<StopDraft>(emptyStop);
  const [deliveryWindowEnd, setDeliveryWindowEnd] = useState('');
  const [rate, setRate] = useState('');
  const [rateIsLinehaul, setRateIsLinehaul] = useState(false);
  const [loadedMiles, setLoadedMiles] = useState('');
  const [deadheadMiles, setDeadheadMiles] = useState('');
  const [brokerName, setBrokerName] = useState('');
  const [brokerLoadNumber, setBrokerLoadNumber] = useState('');
  const [commodity, setCommodity] = useState('');
  const [weightLbs, setWeightLbs] = useState('');
  const [hazmat, setHazmat] = useState(false);
  const [status, setStatus] = useState<LoadStatus>('prospect');
  const [truckId, setTruckId] = useState('');
  const [driverId, setDriverId] = useState('');

  const create = useMutation({
    mutationFn: () =>
      request<{ id: string }>('/v1/loads', {
        body: {
          source: 'manual',
          status,
          ...(brokerName.trim() ? { brokerName: brokerName.trim() } : {}),
          ...(brokerLoadNumber.trim() ? { brokerLoadNumber: brokerLoadNumber.trim() } : {}),
          ...(commodity.trim() ? { commodity: commodity.trim() } : {}),
          ...(numberOrNothing(weightLbs) !== undefined ? { weightLbs: Number(weightLbs) } : {}),
          ...(hazmat ? { hazmat: true } : {}),
          ...(rate.trim() ? { rate: { amount: Math.round(Number(rate) * 100), currency: 'USD' }, rateIsLinehaul } : {}),
          ...(numberOrNothing(loadedMiles) !== undefined ? { expectedLoadedMiles: Number(loadedMiles) } : {}),
          ...(numberOrNothing(deadheadMiles) !== undefined ? { expectedDeadheadMiles: Number(deadheadMiles) } : {}),
          ...(truckId ? { truckId } : {}),
          ...(driverId ? { driverId } : {}),
          stops: [
            stopBody('pickup', pickup),
            {
              ...stopBody('delivery', delivery),
              // datetime-local is bare local time, and `Date` parses it as local.
              ...(deliveryWindowEnd ? { windowEnd: new Date(deliveryWindowEnd).toISOString() } : {}),
            },
          ],
        },
      }),
    onSuccess: async (load) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.loads });
      await navigate({ to: '/loads/$loadId', params: { loadId: load.id }, replace: true });
    },
  });

  const ready =
    pickup.city.trim() && pickup.state.length === 2 && delivery.city.trim() && delivery.state.length === 2;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/" className="text-sm text-brand">
        ‹ Loads
      </Link>
      <h1 className="text-2xl">Add a load</h1>

      <StopFields title="Pickup" value={pickup} onChange={setPickup} />
      <StopFields title="Delivery" value={delivery} onChange={setDelivery}>
        <Field label="Appointment ends" hint="A route arriving after this is called infeasible.">
          <input className="hq-input" type="datetime-local" value={deliveryWindowEnd} onChange={(e) => setDeliveryWindowEnd(e.target.value)} />
        </Field>
      </StopFields>

      <Card title="Rate and miles">
        <div className="space-y-3">
          <Field label="Rate ($)">
            <input className="hq-input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Toggle
            checked={rateIsLinehaul}
            onChange={setRateIsLinehaul}
            label="Linehaul only"
            hint="Fuel surcharge and accessorials are paid on top. Leave off for an all-in rate."
          />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Loaded miles">
              <input className="hq-input" inputMode="numeric" value={loadedMiles} onChange={(e) => setLoadedMiles(e.target.value)} />
            </Field>
            <Field label="Deadhead miles">
              <input className="hq-input" inputMode="numeric" value={deadheadMiles} onChange={(e) => setDeadheadMiles(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-mute">Deadhead, the empty miles to reach the pickup, is what decides whether a load is good.</p>
        </div>
      </Card>

      <Card title="Broker and freight">
        <div className="space-y-3">
          <Field label="Broker">
            <input className="hq-input" value={brokerName} onChange={(e) => setBrokerName(e.target.value)} />
          </Field>
          <Field label="Broker's load number">
            <input className="hq-input" value={brokerLoadNumber} onChange={(e) => setBrokerLoadNumber(e.target.value)} />
          </Field>
          <Field label="Commodity">
            <input className="hq-input" value={commodity} onChange={(e) => setCommodity(e.target.value)} />
          </Field>
          <Field label="Weight (lbs)">
            <input className="hq-input" inputMode="numeric" value={weightLbs} onChange={(e) => setWeightLbs(e.target.value)} />
          </Field>
          <Toggle
            checked={hazmat}
            onChange={setHazmat}
            label="Hazmat"
            hint="Placarded freight. Feasibility checks then screen for hazmat-restricted roads and tunnels."
          />
        </div>
      </Card>

      <Card title="Status and assignment">
        <div className="space-y-3">
          <Field label="Status">
            <select className="hq-input capitalize" value={status} onChange={(e) => setStatus(e.target.value as LoadStatus)}>
              {START_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {prettyStatus(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Truck" hint="Required from dispatched onward.">
            <select className="hq-input" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
              <option value="">No truck yet</option>
              {(trucks.data?.items ?? [])
                .filter((t) => t.active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Driver" hint="The load shows up in this driver's app.">
            <select className="hq-input" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">Not assigned yet</option>
              {(drivers.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <button type="button" className="hq-btn hq-btn-brand w-full" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
        {create.isPending ? 'Adding…' : 'Add load'}
      </button>
      {!ready && <p className="text-center text-xs text-mute">A pickup and a delivery city and state are all that's required.</p>}
      <ErrorNote error={create.error} />
    </div>
  );
}

function StopFields({
  title,
  value,
  onChange,
  children,
}: {
  title: string;
  value: StopDraft;
  onChange: Dispatch<SetStateAction<StopDraft>>;
  children?: ReactNode;
}) {
  // Functional updates, because the coordinate lookup answers asynchronously
  // and must not overwrite whatever was typed while it was in flight.
  const set = (patch: Partial<StopDraft>) => onChange((prev) => ({ ...prev, ...patch }));
  // Changing the address after a lookup filled coordinates clears them, so
  // the lookup runs again for the new address instead of keeping the old spot.
  const setAddress = (patch: Partial<StopDraft>) => set({ ...patch, lat: '', lng: '' });

  return (
    <Card title={title}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Field label="City">
              <input className="hq-input" value={value.city} onChange={(e) => setAddress({ city: e.target.value })} />
            </Field>
          </div>
          <div className="w-20 shrink-0">
            <Field label="State">
              <input
                className="hq-input uppercase"
                maxLength={2}
                autoCapitalize="characters"
                value={value.state}
                onChange={(e) => setAddress({ state: e.target.value.toUpperCase() })}
              />
            </Field>
          </div>
        </div>
        <Field label="Street address" hint="Optional. Sharpens the coordinate lookup.">
          <input className="hq-input" value={value.addressLine1} onChange={(e) => setAddress({ addressLine1: e.target.value })} />
        </Field>
        <Field label="Postal code">
          <input className="hq-input" inputMode="numeric" value={value.postalCode} onChange={(e) => setAddress({ postalCode: e.target.value })} />
        </Field>
        <div className="space-y-1.5">
          <p className="field-label">Coordinates</p>
          <div className="grid grid-cols-2 gap-2">
            <input className="hq-input" inputMode="decimal" placeholder="lat" aria-label={`${title} latitude`} value={value.lat} onChange={(e) => set({ lat: e.target.value })} />
            <input className="hq-input" inputMode="decimal" placeholder="lng" aria-label={`${title} longitude`} value={value.lng} onChange={(e) => set({ lng: e.target.value })} />
          </div>
          <CoordinateLookup
            address={{
              city: value.city,
              state: value.state,
              ...(value.addressLine1 ? { addressLine1: value.addressLine1 } : {}),
              ...(value.postalCode ? { postalCode: value.postalCode } : {}),
            }}
            hasCoordinates={Boolean(value.lat && value.lng)}
            onPick={(c) => set({ lat: String(c.lat), lng: String(c.lng) })}
          />
        </div>
        {children}
      </div>
    </Card>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--color-brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-mute">{hint}</span>
      </span>
    </label>
  );
}
