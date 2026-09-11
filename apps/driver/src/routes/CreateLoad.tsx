/**
 * Create a load — the third bare-minimum owner action, and the one that
 * actually lets a driver see something in their own "Your loads": a load
 * assigned to nobody never reaches a driver's app at all
 * (`driverScopeFor` in `apps/api/src/routes/loads.ts` matches on
 * `loads.driverId`), and a position ping needs a truck assigned or it
 * 422s (`no_truck`). So unlike `apps/web`'s own `AddLoad` — which only
 * wires up `truckId` today — this one offers both pickers from the start.
 *
 * A stop only needs `{ type, city, state }` (`StopBase` in
 * `packages/contracts`) — the same minimum web's own `AddLoad` already
 * gates its "ready" state on.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { request } from '../lib/api.ts';
import { ErrorNote } from '../components/ui.tsx';

interface TruckOption {
  id: string;
  label: string;
}

interface DriverOption {
  id: string;
  fullName: string;
}

export function CreateLoadScreen() {
  const navigate = useNavigate();
  const [pickup, setPickup] = useState({ city: '', state: '' });
  const [delivery, setDelivery] = useState({ city: '', state: '' });
  const [truckId, setTruckId] = useState('');
  const [driverId, setDriverId] = useState('');

  const trucks = useQuery({
    queryKey: ['trucks', 'for-new-load'],
    queryFn: () => request<{ items: TruckOption[] }>('/v1/trucks'),
  });
  const drivers = useQuery({
    queryKey: ['drivers', 'for-new-load'],
    queryFn: () => request<{ items: DriverOption[] }>('/v1/drivers'),
  });

  const create = useMutation({
    mutationFn: () =>
      request<{ id: string }>('/v1/loads', {
        body: {
          stops: [
            { type: 'pickup', city: pickup.city, state: pickup.state },
            { type: 'delivery', city: delivery.city, state: delivery.state },
          ],
          ...(truckId ? { truckId } : {}),
          ...(driverId ? { driverId } : {}),
        },
      }),
    onSuccess: (load) => void navigate({ to: '/loads/$loadId', params: { loadId: load.id } }),
  });

  const ready =
    pickup.city.trim() && pickup.state.trim().length === 2 &&
    delivery.city.trim() && delivery.state.trim().length === 2;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <button className="text-sm text-brand underline" onClick={() => void navigate({ to: '/' })}>
        ← Your loads
      </button>
      <h1 className="text-2xl">Add a load</h1>

      <div className="space-y-2">
        <p className="field-label text-brand">Pickup</p>
        <div className="flex gap-2">
          <input
            className="hq-input"
            placeholder="City"
            value={pickup.city}
            onChange={(e) => setPickup({ ...pickup, city: e.target.value })}
          />
          <input
            className="hq-input w-20"
            placeholder="ST"
            maxLength={2}
            value={pickup.state}
            onChange={(e) => setPickup({ ...pickup, state: e.target.value.toUpperCase() })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <p className="field-label text-brand">Delivery</p>
        <div className="flex gap-2">
          <input
            className="hq-input"
            placeholder="City"
            value={delivery.city}
            onChange={(e) => setDelivery({ ...delivery, city: e.target.value })}
          />
          <input
            className="hq-input w-20"
            placeholder="ST"
            maxLength={2}
            value={delivery.state}
            onChange={(e) => setDelivery({ ...delivery, state: e.target.value.toUpperCase() })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <p className="field-label text-brand">Truck (optional)</p>
        <select className="hq-input" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
          <option value="">No truck yet</option>
          {(trucks.data?.items ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <p className="field-label text-brand">Driver (optional)</p>
        <select className="hq-input" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
          <option value="">Not assigned yet</option>
          {(drivers.data?.items ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.fullName}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        className="hq-btn hq-btn-brand w-full"
        disabled={!ready || create.isPending}
        onClick={() => create.mutate()}
      >
        {create.isPending ? 'Adding…' : 'Add load'}
      </button>
      <ErrorNote error={create.error} />
    </div>
  );
}
