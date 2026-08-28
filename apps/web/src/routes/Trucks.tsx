/**
 * Trucks, and what each one can do.
 *
 * The capability checkboxes carry hint text lifted from the dispatcher's
 * `SettingsForm`, which had already worked out which capabilities actually gate
 * freight and why. Its header stated the problem this screen exists to solve:
 * every value here fails silently. A missing liftgate flag hides every load
 * that mentions one, and nothing tells the carrier that is happening.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ApiRequestError,
  request,
  type MotiveMatchSuggestion,
  type MotiveVehicle,
  type MotiveVehiclesResponse,
  type Truck,
} from '../lib/api.ts';
import { Card, Empty, ErrorNote, Field, LoadMore, Num, Pill } from '../components/ui.tsx';

const CAPABILITIES = [
  { key: 'liftgate', label: 'Liftgate', hint: 'Loads requiring one are hidden without this' },
  { key: 'palletJack', label: 'Pallet jack', hint: 'Carried on the truck, not at the dock' },
  { key: 'driverAssist', label: 'Driver helps load', hint: 'Hand-unload, lumper work' },
  { key: 'twicCard', label: 'TWIC card', hint: 'Ports and secure facilities' },
  { key: 'hazmatEndorsement', label: 'Hazmat', hint: 'Placarded freight' },
  { key: 'securementGear', label: 'Straps and load bars', hint: 'Most trucks have these' },
  { key: 'dockHigh', label: 'Dock high', hint: 'Straight trucks often are not' },
  { key: 'teamDrivers', label: 'Team drivers', hint: 'Two drivers available' },
] as const;

const EQUIPMENT = [
  'STRAIGHT_BOX',
  'DRY_VAN',
  'REEFER',
  'FLATBED',
  'POWER_ONLY',
  'OTHER',
] as const;

const pretty = (equipment: string) =>
  equipment.toLowerCase().replace(/_/g, ' ');

function useSetMotiveVehicle(truckId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (motiveVehicleId: number | null) =>
      request(`/v1/trucks/${truckId}/motive-vehicle`, {
        method: 'PATCH',
        body: { motiveVehicleId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });
}

/**
 * The Motive vehicle match, editable inline. With a fetched vehicle list
 * this is a picker of real names — "12", "Unit 12" — never a raw id a
 * carrier has to go find in Motive's own dashboard first. Falls back to
 * the old numeric field only when Motive is not connected or the vehicle
 * list could not be fetched, so nothing regresses for an org that has not
 * connected yet.
 */
function MotiveVehicleCell({ truck, vehicles }: { truck: Truck; vehicles: MotiveVehicle[] | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(truck.motiveVehicleId ?? ''));
  const save = useSetMotiveVehicle(truck.id);

  const current = vehicles?.find((v) => v.id === truck.motiveVehicleId);

  if (!editing) {
    return (
      <button
        className="text-left hover:underline"
        onClick={() => {
          setValue(String(truck.motiveVehicleId ?? ''));
          setEditing(true);
        }}
      >
        {truck.motiveVehicleId !== null ? (
          <span>{current ? current.number : truck.motiveVehicleId}</span>
        ) : (
          <span className="text-sm text-mute">Not matched</span>
        )}
      </button>
    );
  }

  if (vehicles) {
    return (
      <div className="flex items-center gap-1.5">
        <select
          className="hq-input w-40 py-1 text-sm"
          autoFocus
          defaultValue={truck.motiveVehicleId !== null ? String(truck.motiveVehicleId) : ''}
          onChange={(e) => {
            save.mutate(e.target.value ? Number(e.target.value) : null, {
              onSuccess: () => setEditing(false),
            });
          }}
          disabled={save.isPending}
        >
          <option value="">Not matched</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.number}
              {v.vin ? ` · ${v.vin.slice(-6)}` : ''}
            </option>
          ))}
        </select>
        <button className="hq-btn hq-btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <ErrorNote error={save.error} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        className="hq-input w-28 py-1 text-sm"
        data-numeric="true"
        inputMode="numeric"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Vehicle id"
      />
      <button
        className="hq-btn hq-btn-ghost px-2 py-1 text-xs"
        disabled={save.isPending}
        onClick={() => save.mutate(value.trim() ? Number(value) : null, { onSuccess: () => setEditing(false) })}
      >
        Save
      </button>
      <button className="hq-btn hq-btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(false)}>
        Cancel
      </button>
      <ErrorNote error={save.error} />
    </div>
  );
}

/**
 * Suggested matches waiting for a one-click confirm — the actual
 * hands-off path for the common case where a fleet already calls a Motive
 * vehicle the same thing HaulQ calls the truck. Never applied
 * automatically; see `integrations/motive-match.ts` on the API side for why.
 */
function MotiveMatchSuggestions({ suggestions }: { suggestions: MotiveMatchSuggestion[] }) {
  if (suggestions.length === 0) return null;

  return (
    <Card title="Motive matches to review">
      <p className="mb-3 max-w-prose text-sm text-slate">
        These trucks and Motive vehicles look like the same unit. Confirm the
        ones that are right — nothing is matched until you do.
      </p>
      <ul className="space-y-2">
        {suggestions.map((s) => (
          <SuggestionRow key={s.truckId} suggestion={s} />
        ))}
      </ul>
    </Card>
  );
}

function SuggestionRow({ suggestion }: { suggestion: MotiveMatchSuggestion }) {
  const save = useSetMotiveVehicle(suggestion.truckId);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border border-line p-2.5">
      <span>
        <span className="font-medium">{suggestion.truckLabel}</span>
        <span className="mx-2 text-mute">→</span>
        <span>Motive {suggestion.motiveVehicleNumber}</span>
      </span>
      <div className="flex items-center gap-2">
        <button
          className="hq-btn hq-btn-brand px-3 py-1 text-xs"
          disabled={save.isPending}
          onClick={() => save.mutate(suggestion.motiveVehicleId)}
        >
          {save.isPending ? 'Matching…' : 'Confirm match'}
        </button>
        <ErrorNote error={save.error} />
      </div>
    </li>
  );
}

interface TruckFormValues {
  label: string;
  equipment: string;
  maxWeightLbs: string;
  maxLengthFt: string;
  boxHeightIn: string;
  boxWidthIn: string;
  shortHaulExempt: boolean;
  capabilities: Record<string, boolean>;
}

const EMPTY_TRUCK_FORM: TruckFormValues = {
  label: '',
  equipment: 'STRAIGHT_BOX',
  maxWeightLbs: '',
  maxLengthFt: '',
  boxHeightIn: '',
  boxWidthIn: '',
  shortHaulExempt: false,
  capabilities: {},
};

/** The fields `AddTruck` and `EditTruck` share — same inputs either way, only what happens on submit differs. */
function TruckFields({
  values,
  onChange,
}: {
  values: TruckFormValues;
  onChange: (values: TruckFormValues) => void;
}) {
  return (
    <>
      <div className="grid gap-5 sm:grid-cols-4">
        <Field label="Label" hint="What you call it. “Unit 12”, “the white box”.">
          <input
            className="hq-input"
            value={values.label}
            onChange={(e) => onChange({ ...values, label: e.target.value })}
          />
        </Field>
        <Field label="Equipment">
          <select
            className="hq-input"
            value={values.equipment}
            onChange={(e) => onChange({ ...values, equipment: e.target.value })}
          >
            {EQUIPMENT.map((e) => (
              <option key={e} value={e}>
                {pretty(e)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Max weight (lbs)">
          <input
            className="hq-input"
            data-numeric="true"
            inputMode="numeric"
            value={values.maxWeightLbs}
            onChange={(e) => onChange({ ...values, maxWeightLbs: e.target.value })}
          />
        </Field>
        <Field label="Max length (ft)">
          <input
            className="hq-input"
            data-numeric="true"
            inputMode="numeric"
            value={values.maxLengthFt}
            onChange={(e) => onChange({ ...values, maxLengthFt: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-4">
        <Field label="Box height (in)" hint="Overall vehicle height — bridge clearance, not cargo space.">
          <input
            className="hq-input"
            data-numeric="true"
            inputMode="numeric"
            value={values.boxHeightIn}
            onChange={(e) => onChange({ ...values, boxHeightIn: e.target.value })}
          />
        </Field>
        <Field label="Box width (in)" hint="Overall vehicle width.">
          <input
            className="hq-input"
            data-numeric="true"
            inputMode="numeric"
            value={values.boxWidthIn}
            onChange={(e) => onChange({ ...values, boxWidthIn: e.target.value })}
          />
        </Field>
      </div>

      <fieldset className="mt-6">
        <legend className="field-label mb-1 text-slate">What it can do</legend>
        <p className="mb-3 max-w-prose text-sm text-slate">
          These decide which loads are matched to this truck. Leaving one off
          hides the loads that need it, without saying so.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {CAPABILITIES.map((c) => (
            <label
              key={c.key}
              className="flex cursor-pointer items-start gap-2.5 border border-line p-2.5 hover:border-ink"
            >
              <input
                type="checkbox"
                className="mt-0.5 accent-[--color-brand]"
                checked={values.capabilities[c.key] ?? false}
                onChange={(e) =>
                  onChange({ ...values, capabilities: { ...values.capabilities, [c.key]: e.target.checked } })
                }
              />
              <span>
                <span className="block text-sm font-medium">{c.label}</span>
                <span className="block text-xs text-mute">{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-4 flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5 accent-[--color-brand]"
          checked={values.shortHaulExempt}
          onChange={(e) => onChange({ ...values, shortHaulExempt: e.target.checked })}
        />
        <span>
          <span className="block text-sm font-medium">
            Runs under the 150 air-mile short-haul exemption
          </span>
          <span className="block text-xs text-mute">
            Common for straight trucks. It means ELD coverage is patchy, so
            HaulQ falls back to the driver app for position.
          </span>
        </span>
      </label>
    </>
  );
}

function AddTruck({ onDone }: { onDone: () => void }) {
  const [values, setValues] = useState<TruckFormValues>(EMPTY_TRUCK_FORM);

  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      request<Truck>('/v1/trucks', {
        body: {
          label: values.label,
          equipment: values.equipment,
          ...(values.maxWeightLbs ? { maxWeightLbs: Number(values.maxWeightLbs) } : {}),
          ...(values.maxLengthFt ? { maxLengthFt: Number(values.maxLengthFt) } : {}),
          ...(values.boxHeightIn ? { boxHeightIn: Number(values.boxHeightIn) } : {}),
          ...(values.boxWidthIn ? { boxWidthIn: Number(values.boxWidthIn) } : {}),
          shortHaulExempt: values.shortHaulExempt,
          capabilities: values.capabilities,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDone();
    },
  });

  return (
    <Card title="Add a truck">
      <TruckFields values={values} onChange={setValues} />

      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!values.label || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Adding…' : 'Add truck'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>

      <ErrorNote error={create.error} />
    </Card>
  );
}

function EditTruck({ truck, onDone }: { truck: Truck; onDone: () => void }) {
  const [values, setValues] = useState<TruckFormValues>({
    label: truck.label,
    equipment: truck.equipment,
    maxWeightLbs: truck.maxWeightLbs !== null ? String(truck.maxWeightLbs) : '',
    maxLengthFt: truck.maxLengthFt !== null ? String(truck.maxLengthFt) : '',
    boxHeightIn: truck.boxHeightIn !== null ? String(truck.boxHeightIn) : '',
    boxWidthIn: truck.boxWidthIn !== null ? String(truck.boxWidthIn) : '',
    shortHaulExempt: truck.shortHaulExempt,
    capabilities: truck.capabilities ?? {},
  });

  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      request<Truck>(`/v1/trucks/${truck.id}`, {
        method: 'PATCH',
        body: {
          label: values.label,
          equipment: values.equipment,
          maxWeightLbs: values.maxWeightLbs ? Number(values.maxWeightLbs) : null,
          maxLengthFt: values.maxLengthFt ? Number(values.maxLengthFt) : null,
          boxHeightIn: values.boxHeightIn ? Number(values.boxHeightIn) : null,
          boxWidthIn: values.boxWidthIn ? Number(values.boxWidthIn) : null,
          shortHaulExempt: values.shortHaulExempt,
          capabilities: values.capabilities,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDone();
    },
  });

  return (
    <Card title={`Edit ${truck.label}`}>
      <TruckFields values={values} onChange={setValues} />

      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!values.label || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>

      <ErrorNote error={save.error} />
    </Card>
  );
}

/**
 * Delete, in this app's sense: take the truck out of service, not erase it.
 * `contracts`' `SetTruckActiveSchema` has the reasoning — a truck stays
 * referenced by loads, drivers and telemetry for as long as it was ever
 * run. Deactivating needs a confirm step the way `StatusControl`'s cancel
 * does in `Loads.tsx`; reactivating does not, since nothing is lost by it.
 */
function TruckActiveControl({ truck }: { truck: Truck }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');

  const setActive = useMutation({
    mutationFn: (input: { active: boolean; reason?: string }) =>
      request(`/v1/trucks/${truck.id}/active`, { method: 'PATCH', body: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      setConfirming(false);
      setReason('');
    },
  });

  if (!truck.active) {
    return (
      <button
        className="hq-btn hq-btn-ghost px-2 py-1 text-xs"
        disabled={setActive.isPending}
        onClick={() => setActive.mutate({ active: true })}
      >
        {setActive.isPending ? 'Reactivating…' : 'Reactivate'}
      </button>
    );
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          className="hq-input w-32 py-1 text-xs"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="hq-btn hq-btn-ghost px-2 py-1 text-xs text-bad"
          disabled={setActive.isPending}
          onClick={() => setActive.mutate({ active: false, ...(reason.trim() ? { reason: reason.trim() } : {}) })}
        >
          {setActive.isPending ? 'Removing…' : 'Confirm'}
        </button>
        <button className="hq-btn hq-btn-ghost px-2 py-1 text-xs" onClick={() => setConfirming(false)}>
          Cancel
        </button>
        <ErrorNote error={setActive.error} />
      </div>
    );
  }

  return (
    <button
      className="hq-btn hq-btn-ghost px-2 py-1 text-xs text-bad"
      onClick={() => setConfirming(true)}
    >
      Delete
    </button>
  );
}

export function TrucksScreen() {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const trucks = useInfiniteQuery({
    queryKey: ['trucks'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      request<{ items: Truck[]; nextCursor: string | null }>(
        `/v1/trucks${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const truckItems = trucks.data?.pages.flatMap((p) => p.items) ?? [];

  // 409 (`not_connected`) is the expected answer for an org that has not
  // connected Motive yet, not a failure worth retrying or showing an error
  // for — the picker just falls back to the manual field below.
  const motive = useQuery({
    queryKey: ['motive-vehicles'],
    queryFn: () => request<MotiveVehiclesResponse>('/v1/integrations/motive/vehicles'),
    retry: false,
  });
  const motiveNotConnected =
    motive.isError && motive.error instanceof ApiRequestError && motive.error.code === 'not_connected';
  const vehicles = motive.data?.vehicles ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-3xl">Trucks</h1>
        {!adding && (
          <button className="hq-btn hq-btn-primary" onClick={() => setAdding(true)}>
            Add a truck
          </button>
        )}
      </div>

      {adding && <AddTruck onDone={() => setAdding(false)} />}

      {editingId &&
        (() => {
          const editing = truckItems.find((t) => t.id === editingId);
          if (!editing) return null;
          return <EditTruck truck={editing} onDone={() => setEditingId(null)} />;
        })()}

      {motive.data && <MotiveMatchSuggestions suggestions={motive.data.suggestions} />}
      {motive.isError && !motiveNotConnected && <ErrorNote error={motive.error} />}

      <Card>
        {trucks.isError && <ErrorNote error={trucks.error} />}
        {trucks.data && truckItems.length === 0 && (
          <Empty>No trucks yet. Nothing can be matched or assigned until one exists.</Empty>
        )}

        {truckItems.length > 0 && (
          <div className="overflow-x-auto">
            {/* A load grid has more columns than a phone has width. Scroll it
                inside its own box rather than letting it widen the page. */}
            <table className="hq-table">
              <thead>
                <tr>
                  <th className="field-label">Label</th>
                  <th className="field-label">Equipment</th>
                  <th className="field-label">Max weight</th>
                  <th className="field-label">Can do</th>
                  <th className="field-label">
                    Motive vehicle
                    {motiveNotConnected && (
                      <span className="ml-1 font-normal normal-case text-mute">
                        (<a href="/integrations" className="underline">connect Motive</a> to pick from a list)
                      </span>
                    )}
                  </th>
                  <th className="field-label">Actions</th>
                </tr>
              </thead>
              <tbody>
                {truckItems.map((truck) => {
                  const enabled = Object.entries(truck.capabilities ?? {})
                    .filter(([, on]) => on)
                    .map(([k]) => CAPABILITIES.find((c) => c.key === k)?.label ?? k);

                  return (
                    <tr key={truck.id} className={!truck.active ? 'opacity-60' : undefined}>
                      <td className="font-medium">
                        {truck.label}
                        {!truck.active && (
                          <span className="ml-1.5">
                            <Pill tone="neutral">Inactive</Pill>
                          </span>
                        )}
                      </td>
                      <td className="text-slate">{pretty(truck.equipment)}</td>
                      <td>
                        {truck.maxWeightLbs ? (
                          <Num value={truck.maxWeightLbs} />
                        ) : (
                          <span className="text-mute">—</span>
                        )}
                      </td>
                      <td>
                        {enabled.length ? (
                          <span className="flex flex-wrap gap-1.5">
                            {enabled.map((label) => (
                              <Pill key={label}>{label}</Pill>
                            ))}
                          </span>
                        ) : (
                          <span className="text-sm text-warn">
                            Nothing set — loads needing equipment may be hidden
                          </span>
                        )}
                      </td>
                      <td>
                        <MotiveVehicleCell truck={truck} vehicles={vehicles} />
                      </td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            className="hq-btn hq-btn-ghost px-2 py-1 text-xs"
                            onClick={() => setEditingId(truck.id)}
                          >
                            Edit
                          </button>
                          <TruckActiveControl truck={truck} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <LoadMore
          onClick={() => trucks.fetchNextPage()}
          loading={trucks.isFetchingNextPage}
          hasMore={trucks.hasNextPage}
        />
      </Card>
    </div>
  );
}
