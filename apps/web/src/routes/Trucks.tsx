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
import { request, type Truck } from '../lib/api.ts';
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

      <Card>
        {trucks.isError && <ErrorNote error={trucks.error} />}
        {trucks.data?.items.length === 0 && (
          <Empty>No trucks yet. Nothing can be matched or assigned until one exists.</Empty>
        )}

        {trucks.data && trucks.data.items.length > 0 && (
          <table className="hq-table">
            <thead>
              <tr>
                <th className="field-label">Label</th>
                <th className="field-label">Equipment</th>
                <th className="field-label">Max weight</th>
                <th className="field-label">Can do</th>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
