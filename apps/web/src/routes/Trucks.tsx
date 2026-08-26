/**
 * Trucks, and what each one can do.
 *
 * The capability checkboxes carry hint text lifted from the dispatcher's
 * `SettingsForm`, which had already worked out which capabilities actually gate
 * freight and why. Its header stated the problem this screen exists to solve:
 * every value here fails silently. A missing liftgate flag hides every load
 * that mentions one, and nothing tells the carrier that is happening.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ApiRequestError,
  request,
  type MotiveMatchSuggestion,
  type MotiveVehicle,
  type MotiveVehiclesResponse,
  type Truck,
} from '../lib/api.ts';
import { Card, Empty, ErrorNote, Field, Num, Pill } from '../components/ui.tsx';

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

function AddTruck({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState('');
  const [equipment, setEquipment] = useState<string>('STRAIGHT_BOX');
  const [maxWeightLbs, setMaxWeight] = useState('');
  const [shortHaulExempt, setShortHaul] = useState(false);
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});

  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      request<Truck>('/v1/trucks', {
        body: {
          label,
          equipment,
          ...(maxWeightLbs ? { maxWeightLbs: Number(maxWeightLbs) } : {}),
          shortHaulExempt,
          capabilities,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDone();
    },
  });

  return (
    <Card title="Add a truck">
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Label" hint="What you call it. “Unit 12”, “the white box”.">
          <input
            className="hq-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Equipment">
          <select
            className="hq-input"
            value={equipment}
            onChange={(e) => setEquipment(e.target.value)}
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
            value={maxWeightLbs}
            onChange={(e) => setMaxWeight(e.target.value)}
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
                checked={capabilities[c.key] ?? false}
                onChange={(e) =>
                  setCapabilities({ ...capabilities, [c.key]: e.target.checked })
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
          checked={shortHaulExempt}
          onChange={(e) => setShortHaul(e.target.checked)}
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

      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!label || create.isPending}
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

export function TrucksScreen() {
  const [adding, setAdding] = useState(false);
  const trucks = useQuery({
    queryKey: ['trucks'],
    queryFn: () => request<{ items: Truck[] }>('/v1/trucks'),
  });

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

      {motive.data && <MotiveMatchSuggestions suggestions={motive.data.suggestions} />}
      {motive.isError && !motiveNotConnected && <ErrorNote error={motive.error} />}

      <Card>
        {trucks.isError && <ErrorNote error={trucks.error} />}
        {trucks.data?.items.length === 0 && (
          <Empty>No trucks yet. Nothing can be matched or assigned until one exists.</Empty>
        )}

        {trucks.data && trucks.data.items.length > 0 && (
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
                </tr>
              </thead>
              <tbody>
                {trucks.data.items.map((truck) => {
                  const enabled = Object.entries(truck.capabilities ?? {})
                    .filter(([, on]) => on)
                    .map(([k]) => CAPABILITIES.find((c) => c.key === k)?.label ?? k);
  
                  return (
                    <tr key={truck.id}>
                      <td className="font-medium">{truck.label}</td>
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
