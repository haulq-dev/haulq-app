/**
 * Trucks. Web's `Trucks.tsx` on a phone (MOBILE_PARITY_PLAN.md M4).
 *
 * Web's table puts editing, the Motive picker and deactivation in each row.
 * Here the list is cards and each truck opens its own screen, the same shape
 * as loads and invoices. Two things stay on the list because they are about
 * the fleet, not one truck:
 *
 * - **Motive matches to review**: a truck and a Motive vehicle that look like
 *   the same unit, confirmed with one tap. Never applied automatically (see
 *   `integrations/motive-match.ts` on the API).
 * - **Motive vehicles with no truck**: one tap creates the truck and matches it.
 *
 * Both only appear for a carrier with Motive connected, and only for the
 * roles the API lets read Motive (owner, dispatcher).
 */

import {
  canDispatch,
  capabilityLabels,
  equipmentLabel,
  isMotiveNotConnected,
  unmatchedMotiveVehicles,
  useCreateTruckFromMotive,
  useMotiveVehicles,
  useSetMotiveVehicle,
  useTruckList,
  type MotiveMatchSuggestion,
  type MotiveVehicle,
  type Truck,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, LoadMore, Pill } from '../../components/ui.tsx';

export function TrucksScreen() {
  const canWrite = canDispatch(useSession()?.role);
  const trucks = useTruckList();
  const list = trucks.data?.pages.flatMap((p) => p.items) ?? [];
  const motive = useMotiveVehicles({ enabled: canWrite });
  const unmatched = motive.data ? unmatchedMotiveVehicles(motive.data.vehicles, list, motive.data.suggestions) : [];

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ More
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl">Trucks</h1>
        {canWrite && (
          <Link to="/trucks/new" className="hq-btn hq-btn-brand active:scale-100" aria-label="Add a truck">
            + Add
          </Link>
        )}
      </div>

      {motive.data && motive.data.suggestions.length > 0 && <Suggestions suggestions={motive.data.suggestions} />}
      {unmatched.length > 0 && <Unmatched vehicles={unmatched} />}
      {motive.isError && !isMotiveNotConnected(motive.error) && <ErrorNote error={motive.error} />}

      {trucks.isError && <ErrorNote error={trucks.error} />}
      {trucks.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {trucks.isSuccess && list.length === 0 && (
        <div className="hq-card px-4">
          <Empty>No trucks yet. Nothing can be matched or assigned until one exists.</Empty>
        </div>
      )}

      <ul className="space-y-3">
        {list.map((truck) => (
          <li key={truck.id}>
            <TruckCard truck={truck} vehicles={motive.data?.vehicles ?? null} />
          </li>
        ))}
      </ul>
      <LoadMore onClick={() => void trucks.fetchNextPage()} loading={trucks.isFetchingNextPage} hasMore={trucks.hasNextPage} />
    </div>
  );
}

function TruckCard({ truck, vehicles }: { truck: Truck; vehicles: MotiveVehicle[] | null }) {
  const can = capabilityLabels(truck.capabilities);
  const motiveNumber =
    truck.motiveVehicleId === null ? null : (vehicles?.find((v) => v.id === truck.motiveVehicleId)?.number ?? String(truck.motiveVehicleId));

  return (
    <Link to="/trucks/$truckId" params={{ truckId: truck.id }} className={`block ${truck.active ? '' : 'opacity-60'}`}>
      <Card>
        <div className="flex items-center justify-between gap-2">
          <span className="text-lg font-semibold">{truck.label}</span>
          {!truck.active && <Pill>out of service</Pill>}
        </div>
        <p className="text-sm text-mute">
          {equipmentLabel(truck.equipment) ?? truck.equipment}
          {truck.maxWeightLbs !== null && ` · ${truck.maxWeightLbs.toLocaleString()} lbs`}
          {motiveNumber && ` · Motive ${motiveNumber}`}
        </p>
        {can.length > 0 ? (
          <p className="mt-2 text-sm text-slate">{can.join(' · ')}</p>
        ) : (
          <p className="mt-2 text-sm text-warn">Nothing set it can do. Loads needing equipment may be hidden.</p>
        )}
      </Card>
    </Link>
  );
}

function Suggestions({ suggestions }: { suggestions: MotiveMatchSuggestion[] }) {
  const match = useSetMotiveVehicle();
  return (
    <Card title="Motive matches to review">
      <p className="mb-2 text-sm text-slate">These look like the same unit. Nothing is matched until you confirm.</p>
      <ul className="divide-y divide-line">
        {suggestions.map((s) => (
          <li key={s.truckId} className="flex items-center justify-between gap-3 py-2.5">
            <span>
              <span className="font-medium">{s.truckLabel}</span>
              <span className="text-mute"> → Motive {s.motiveVehicleNumber}</span>
            </span>
            <button
              type="button"
              className="hq-btn hq-btn-primary shrink-0 px-3 py-1.5 text-sm"
              disabled={match.isPending}
              onClick={() => match.mutate({ truckId: s.truckId, motiveVehicleId: s.motiveVehicleId })}
            >
              Confirm
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote error={match.error} />
    </Card>
  );
}

function Unmatched({ vehicles }: { vehicles: MotiveVehicle[] }) {
  const create = useCreateTruckFromMotive();
  return (
    <Card title="In Motive, not in HaulQ">
      <p className="mb-2 text-sm text-slate">Create a truck for one to start tracking it. It's matched in the same step.</p>
      <ul className="divide-y divide-line">
        {vehicles.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-3 py-2.5">
            <span>
              Motive {v.number}
              {v.vin && <span className="num text-xs text-mute"> · VIN …{v.vin.slice(-6)}</span>}
            </span>
            <button
              type="button"
              className="hq-btn hq-btn-ghost shrink-0 px-3 py-1.5 text-sm"
              disabled={create.isPending}
              onClick={() => create.mutate(v)}
            >
              {create.isPending && create.variables?.id === v.id ? 'Creating…' : 'Create truck'}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote error={create.error} />
    </Card>
  );
}
