/**
 * Trucks, and what each one can do.
 *
 * The capability checkboxes carry hint text lifted from the dispatcher's
 * `SettingsForm`, which had already worked out which capabilities actually gate
 * freight and why. Its header stated the problem this screen exists to solve:
 * every value here fails silently. A missing liftgate flag hides every load
 * that mentions one, and nothing tells the carrier that is happening.
 *
 * The capability list, the form ↔ request rules, Motive matching and every
 * request come from `@haulq/client`'s `fleet.ts` and its hooks, shared with the
 * mobile app, so the two can't disagree about what a truck form sends.
 */

import {
  canDispatch,
  capabilityLabels,
  EMPTY_TRUCK_FORM,
  EQUIPMENT_OPTIONS,
  equipmentLabel,
  isMotiveNotConnected,
  TRUCK_CAPABILITIES,
  truckBody,
  truckToForm,
  unmatchedMotiveVehicles,
  useCreateTruck,
  useCreateTruckFromMotive,
  useMotiveVehicles,
  useSetMotiveVehicle,
  useSetTruckActive,
  useTruckList,
  useUpdateTruck,
  type MotiveMatchSuggestion,
  type MotiveVehicle,
  type Truck,
  type TruckFormValues,
} from '@haulq/client';
import { useState } from 'react';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, LoadMore, Num, Pill } from '../components/ui.tsx';

/**
 * The Motive vehicle match, editable inline. With a fetched vehicle list this
 * is a picker of real names — "12", "Unit 12" — never a raw id a carrier has
 * to go find in Motive's own dashboard first. Falls back to a numeric field
 * only when Motive is not connected or the list could not be fetched.
 */
function MotiveVehicleCell({ truck, vehicles, canWrite }: { truck: Truck; vehicles: MotiveVehicle[] | null; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(truck.motiveVehicleId ?? ''));
  const save = useSetMotiveVehicle();
  const current = vehicles?.find((v) => v.id === truck.motiveVehicleId);
  const label = truck.motiveVehicleId !== null ? <span>{current ? current.number : truck.motiveVehicleId}</span> : <span className="text-sm text-mute">Not matched</span>;

  if (!canWrite) return label;
  if (!editing) {
    return (
      <button
        className="text-left hover:underline"
        onClick={() => {
          setValue(String(truck.motiveVehicleId ?? ''));
          setEditing(true);
        }}
      >
        {label}
      </button>
    );
  }

  const set = (motiveVehicleId: number | null) => save.mutate({ truckId: truck.id, motiveVehicleId }, { onSuccess: () => setEditing(false) });

  if (vehicles) {
    return (
      <div className="flex items-center gap-1.5">
        <select
          className="hq-input w-40 py-1 text-sm"
          autoFocus
          defaultValue={truck.motiveVehicleId !== null ? String(truck.motiveVehicleId) : ''}
          onChange={(e) => set(e.target.value ? Number(e.target.value) : null)}
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
      <button className="hq-btn hq-btn-ghost px-2 py-1 text-xs" disabled={save.isPending} onClick={() => set(value.trim() ? Number(value) : null)}>
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
 * Suggested matches waiting for a one-click confirm. Never applied
 * automatically; see `integrations/motive-match.ts` on the API side for why.
 */
function MotiveMatchSuggestions({ suggestions }: { suggestions: MotiveMatchSuggestion[] }) {
  const save = useSetMotiveVehicle();
  if (suggestions.length === 0) return null;

  return (
    <Card title="Motive matches to review">
      <p className="mb-3 max-w-prose text-sm text-slate">These trucks and Motive vehicles look like the same unit. Confirm the ones that are right — nothing is matched until you do.</p>
      <ul className="space-y-2">
        {suggestions.map((s) => (
          <li key={s.truckId} className="flex flex-wrap items-center justify-between gap-2 border border-line p-2.5">
            <span>
              <span className="font-medium">{s.truckLabel}</span>
              <span className="mx-2 text-mute">→</span>
              <span>Motive {s.motiveVehicleNumber}</span>
            </span>
            <button
              className="hq-btn hq-btn-brand px-3 py-1 text-xs"
              disabled={save.isPending}
              onClick={() => save.mutate({ truckId: s.truckId, motiveVehicleId: s.motiveVehicleId })}
            >
              {save.isPending && save.variables?.truckId === s.truckId ? 'Matching…' : 'Confirm match'}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote error={save.error} />
    </Card>
  );
}

/**
 * Motive vehicles nothing in HaulQ claims yet. One click creates the truck and
 * matches it in the same step. Left off entirely once empty.
 */
function UnmatchedMotiveVehicles({ vehicles }: { vehicles: MotiveVehicle[] }) {
  const create = useCreateTruckFromMotive();
  if (vehicles.length === 0) return null;

  return (
    <Card title="Motive vehicles with no HaulQ truck">
      <p className="mb-3 max-w-prose text-sm text-slate">These are on the Motive account but nothing here matches them yet. Create a truck for one to start tracking it.</p>
      <ul className="space-y-2">
        {vehicles.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 border border-line p-2.5">
            <span>
              Motive {v.number}
              {v.vin ? <span className="ml-2 text-sm text-mute">VIN ···{v.vin.slice(-6)}</span> : null}
            </span>
            <button className="hq-btn hq-btn-ghost px-3 py-1 text-xs" disabled={create.isPending} onClick={() => create.mutate(v)}>
              {create.isPending && create.variables?.id === v.id ? 'Creating…' : 'Create truck'}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote error={create.error} />
    </Card>
  );
}

/** The fields `AddTruck` and `EditTruck` share — same inputs either way, only what happens on submit differs. */
function TruckFields({ values, onChange }: { values: TruckFormValues; onChange: (values: TruckFormValues) => void }) {
  const number = (key: 'maxWeightLbs' | 'maxLengthFt' | 'boxHeightIn' | 'boxWidthIn', label: string, hint?: string) => (
    <Field label={label} {...(hint ? { hint } : {})}>
      <input className="hq-input" data-numeric="true" inputMode="numeric" value={values[key]} onChange={(e) => onChange({ ...values, [key]: e.target.value })} />
    </Field>
  );

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-4">
        <Field label="Label" hint="What you call it. “Unit 12”, “the white box”.">
          <input className="hq-input" value={values.label} onChange={(e) => onChange({ ...values, label: e.target.value })} />
        </Field>
        <Field label="Equipment">
          <select className="hq-input" value={values.equipment} onChange={(e) => onChange({ ...values, equipment: e.target.value })}>
            {EQUIPMENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {number('maxWeightLbs', 'Max weight (lbs)')}
        {number('maxLengthFt', 'Max length (ft)')}
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-4">
        {number('boxHeightIn', 'Box height (in)', 'Overall vehicle height — bridge clearance, not cargo space.')}
        {number('boxWidthIn', 'Box width (in)', 'Overall vehicle width.')}
      </div>

      <fieldset className="mt-6">
        <legend className="field-label mb-1 text-slate">What it can do</legend>
        <p className="mb-3 max-w-prose text-sm text-slate">These decide which loads are matched to this truck. Leaving one off hides the loads that need it, without saying so.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {TRUCK_CAPABILITIES.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-start gap-2.5 border border-line p-2.5 hover:border-ink">
              <input
                type="checkbox"
                className="mt-0.5 accent-[--color-brand]"
                checked={values.capabilities[c.key] ?? false}
                onChange={(e) => onChange({ ...values, capabilities: { ...values.capabilities, [c.key]: e.target.checked } })}
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
          <span className="block text-sm font-medium">Runs under the 150 air-mile short-haul exemption</span>
          <span className="block text-xs text-mute">Common for straight trucks. It means ELD coverage is patchy, so HaulQ falls back to the driver app for position.</span>
        </span>
      </label>
    </>
  );
}

/** A number that isn't a whole positive number is named, rather than sent to bounce off the API. */
function InvalidNote({ values, mode }: { values: TruckFormValues; mode: 'create' | 'update' }) {
  const result = truckBody(values, mode);
  return 'invalid' in result && values.label.trim() ? <p className="mt-3 text-sm text-bad">{result.invalid} needs a whole number.</p> : null;
}

function AddTruck({ onDone }: { onDone: () => void }) {
  const [values, setValues] = useState<TruckFormValues>(EMPTY_TRUCK_FORM);
  const create = useCreateTruck();
  const result = truckBody(values, 'create');

  return (
    <Card title="Add a truck">
      <TruckFields values={values} onChange={setValues} />
      <InvalidNote values={values} mode="create" />
      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!('body' in result) || create.isPending}
          onClick={() => 'body' in result && create.mutate(result.body, { onSuccess: onDone })}
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
  const [values, setValues] = useState<TruckFormValues>(() => truckToForm(truck));
  const update = useUpdateTruck();
  const result = truckBody(values, 'update');

  return (
    <Card title={`Edit ${truck.label}`}>
      <TruckFields values={values} onChange={setValues} />
      <InvalidNote values={values} mode="update" />
      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!('body' in result) || update.isPending}
          onClick={() => 'body' in result && update.mutate({ id: truck.id, body: result.body }, { onSuccess: onDone })}
        >
          {update.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNote error={update.error} />
    </Card>
  );
}

/**
 * Delete, in this app's sense: take the truck out of service, not erase it —
 * a truck stays referenced by loads, drivers and telemetry for as long as it
 * was ever run. Taking one out asks first; putting it back does not.
 */
function TruckActiveControl({ truck }: { truck: Truck }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const setActive = useSetTruckActive();

  if (!truck.active) {
    return (
      <button className="hq-btn hq-btn-ghost px-2 py-1 text-xs" disabled={setActive.isPending} onClick={() => setActive.mutate({ id: truck.id, active: true })}>
        {setActive.isPending ? 'Reactivating…' : 'Reactivate'}
      </button>
    );
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <input className="hq-input w-32 py-1 text-xs" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button
          className="hq-btn hq-btn-ghost px-2 py-1 text-xs text-bad"
          disabled={setActive.isPending}
          onClick={() =>
            setActive.mutate(
              { id: truck.id, active: false, ...(reason.trim() ? { reason: reason.trim() } : {}) },
              {
                onSuccess: () => {
                  setConfirming(false);
                  setReason('');
                },
              },
            )
          }
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
    <button className="hq-btn hq-btn-ghost px-2 py-1 text-xs text-bad" onClick={() => setConfirming(true)}>
      Delete
    </button>
  );
}

export function TrucksScreen() {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const session = useSession();
  const orgs = useOrgs();
  const canWrite = canDispatch(orgs.data?.items.find((o) => o.id === session?.orgId)?.role);

  const trucks = useTruckList();
  const truckItems = trucks.data?.pages.flatMap((p) => p.items) ?? [];

  // 409 `not_connected` is the expected answer for an org that has not
  // connected Motive yet, not a failure worth showing — the picker falls back
  // to the manual field. Motive is only readable by owner and dispatcher.
  const motive = useMotiveVehicles({ enabled: canWrite });
  const motiveNotConnected = motive.isError && isMotiveNotConnected(motive.error);
  const vehicles = motive.data?.vehicles ?? null;
  const unmatched = motive.data ? unmatchedMotiveVehicles(motive.data.vehicles, truckItems, motive.data.suggestions) : [];
  const editing = truckItems.find((t) => t.id === editingId);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-3xl">Trucks</h1>
        {canWrite && !adding && (
          <button className="hq-btn hq-btn-primary" onClick={() => setAdding(true)}>
            Add a truck
          </button>
        )}
      </div>

      {adding && <AddTruck onDone={() => setAdding(false)} />}
      {editing && <EditTruck key={editing.id} truck={editing} onDone={() => setEditingId(null)} />}

      {motive.data && <MotiveMatchSuggestions suggestions={motive.data.suggestions} />}
      {motive.data && <UnmatchedMotiveVehicles vehicles={unmatched} />}
      {motive.isError && !motiveNotConnected && <ErrorNote error={motive.error} />}

      <Card>
        {trucks.isError && <ErrorNote error={trucks.error} />}
        {trucks.isLoading && <Empty>Loading…</Empty>}
        {trucks.data && truckItems.length === 0 && <Empty>No trucks yet. Nothing can be matched or assigned until one exists.</Empty>}

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
                  {canWrite && <th className="field-label">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {truckItems.map((truck) => {
                  const enabled = capabilityLabels(truck.capabilities);
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
                      <td className="text-slate">{equipmentLabel(truck.equipment) ?? truck.equipment}</td>
                      <td>{truck.maxWeightLbs ? <Num value={truck.maxWeightLbs} /> : <span className="text-mute">—</span>}</td>
                      <td>
                        {enabled.length ? (
                          <span className="flex flex-wrap gap-1.5">
                            {enabled.map((label) => (
                              <Pill key={label}>{label}</Pill>
                            ))}
                          </span>
                        ) : (
                          <span className="text-sm text-warn">Nothing set — loads needing equipment may be hidden</span>
                        )}
                      </td>
                      <td>
                        <MotiveVehicleCell truck={truck} vehicles={vehicles} canWrite={canWrite} />
                      </td>
                      {canWrite && (
                        <td>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button className="hq-btn hq-btn-ghost px-2 py-1 text-xs" onClick={() => setEditingId(truck.id)}>
                              Edit
                            </button>
                            <TruckActiveControl truck={truck} />
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <LoadMore onClick={() => void trucks.fetchNextPage()} loading={trucks.isFetchingNextPage} hasMore={trucks.hasNextPage} />
      </Card>
    </div>
  );
}
