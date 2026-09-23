/**
 * Moving a load along, and who is running it. Owners and dispatchers only;
 * the API's `requireRole` enforces that.
 *
 * **Only moves that can succeed are offered.** `nextStatuses` from
 * `@haulq/contracts` mirrors the database trigger, the same rule web's
 * `StatusControl` applies. The trigger still decides, and a disagreement
 * surfaces as the API's own explanation.
 *
 * Assignment sets truck and driver together. `PATCH /assignment` has always
 * accepted `driverId`; web only exposes the truck.
 */

import { nextStatuses, type LoadStatus } from '@haulq/contracts';
import { prettyStatus, useDrivers, useTrucks, type Load } from '@haulq/client';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { request } from '../../lib/api.ts';
import { tapFeedback } from '../../lib/haptics.ts';
import { ErrorNote, Field } from '../../components/ui.tsx';
import { useRefreshLoad } from './shared.tsx';

export function StatusControl({ load }: { load: Load }) {
  const refresh = useRefreshLoad(load.id);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const move = useMutation({
    mutationFn: (next: { status: LoadStatus; reason?: string }) =>
      request(`/v1/loads/${load.id}/status`, { method: 'PATCH', body: next }),
    onSuccess: async () => {
      setCancelling(false);
      setReason('');
      await refresh();
    },
  });

  const options = nextStatuses(load.status);
  if (options.length === 0) return <p className="text-sm text-mute">No further moves from {prettyStatus(load.status)}.</p>;

  if (cancelling) {
    return (
      <div className="space-y-2">
        <Field label="Why is this cancelled?">
          <input className="hq-input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        <div className="flex gap-2">
          <button
            type="button"
            className="hq-btn flex-1 bg-bad text-white"
            disabled={!reason.trim() || move.isPending}
            onClick={() => move.mutate({ status: 'cancelled', reason: reason.trim() })}
          >
            {move.isPending ? 'Cancelling…' : 'Cancel load'}
          </button>
          <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setCancelling(false)}>
            Back
          </button>
        </div>
        <ErrorNote error={move.error} />
      </div>
    );
  }

  const forward = options.filter((s) => s !== 'cancelled');
  return (
    <div className="space-y-2">
      <p className="field-label">Move to</p>
      <div className="flex flex-wrap gap-2">
        {forward.map((s) => (
          <button
            key={s}
            type="button"
            className="hq-btn hq-btn-primary capitalize"
            disabled={move.isPending}
            onClick={() => {
              void tapFeedback();
              move.mutate({ status: s });
            }}
          >
            {prettyStatus(s)}
          </button>
        ))}
        {options.includes('cancelled') && (
          <button type="button" className="hq-btn hq-btn-ghost text-bad" disabled={move.isPending} onClick={() => setCancelling(true)}>
            Cancel…
          </button>
        )}
      </div>
      <ErrorNote error={move.error} />
    </div>
  );
}

export function AssignmentControl({ load }: { load: Load }) {
  const refresh = useRefreshLoad(load.id);
  const trucks = useTrucks();
  const drivers = useDrivers();

  const assign = useMutation({
    mutationFn: (next: { truckId: string | null; driverId: string | null }) =>
      request(`/v1/loads/${load.id}/assignment`, { method: 'PATCH', body: next }),
    onSuccess: refresh,
  });

  // Out-of-service trucks can't take new work, but the one already on this
  // load must stay selectable or the picker would show it as blank.
  const truckOptions = (trucks.data?.items ?? []).filter((t) => t.active || t.id === load.truckId);

  return (
    <div className="space-y-3">
      <Field label="Truck" hint="Required from dispatched onward.">
        <select
          className="hq-input"
          value={load.truckId ?? ''}
          disabled={assign.isPending}
          onChange={(e) => assign.mutate({ truckId: e.target.value || null, driverId: load.driverId })}
        >
          <option value="">No truck</option>
          {truckOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Driver">
        <select
          className="hq-input"
          value={load.driverId ?? ''}
          disabled={assign.isPending}
          onChange={(e) => assign.mutate({ truckId: load.truckId, driverId: e.target.value || null })}
        >
          <option value="">No driver</option>
          {(drivers.data?.items ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.fullName}
            </option>
          ))}
        </select>
      </Field>
      <ErrorNote error={assign.error} />
    </div>
  );
}
