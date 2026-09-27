/**
 * One truck: edit it, match it to its Motive vehicle, take it out of service.
 * Also the "Add a truck" screen (`/trucks/new`), which is the same form.
 *
 * There's no `GET /v1/trucks/:id`, so the truck comes from the list cache
 * (`useTruckList`), fetching further pages if it isn't on the first. Fleets
 * this app is for fit on one page.
 *
 * "Out of service", never delete: a truck stays referenced by its loads and
 * telemetry (`SetTruckActiveSchema`). Taking one out asks first, the same
 * as web; putting it back doesn't, since nothing is lost.
 */

import {
  canDispatch,
  EMPTY_TRUCK_FORM,
  isMotiveNotConnected,
  truckBody,
  truckToForm,
  useCreateTruck,
  useMotiveVehicles,
  useSetMotiveVehicle,
  useSetTruckActive,
  useTruckList,
  useUpdateTruck,
  type Truck,
  type TruckFormValues,
} from '@haulq/client';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, ErrorNote, Field, Note } from '../../components/ui.tsx';
import { successFeedback } from '../../lib/haptics.ts';
import { TruckForm } from './TruckForm.tsx';

export function NewTruckScreen() {
  const navigate = useNavigate();
  const [values, setValues] = useState<TruckFormValues>(EMPTY_TRUCK_FORM);
  const create = useCreateTruck();
  const result = truckBody(values, 'create');

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/trucks" className="text-sm text-brand">
        ‹ Trucks
      </Link>
      <h1 className="text-2xl">Add a truck</h1>
      <TruckForm values={values} onChange={setValues} />
      {'invalid' in result && values.label.trim() && <p className="text-sm text-bad">{result.invalid} needs a whole number.</p>}
      <button
        type="button"
        className="hq-btn hq-btn-brand w-full"
        disabled={!('body' in result) || create.isPending}
        onClick={() =>
          'body' in result &&
          create.mutate(result.body, {
            onSuccess: (truck) => {
              successFeedback();
              void navigate({ to: '/trucks/$truckId', params: { truckId: truck.id }, replace: true });
            },
          })
        }
      >
        {create.isPending ? 'Adding…' : 'Add truck'}
      </button>
      <ErrorNote error={create.error} />
    </div>
  );
}

export function TruckScreen() {
  const { truckId } = useParams({ from: '/trucks/$truckId' });
  const trucks = useTruckList();
  const truck = trucks.data?.pages.flatMap((p) => p.items).find((t) => t.id === truckId);

  // Not on the pages loaded so far: keep paging until it is, or there are none left.
  useEffect(() => {
    if (!truck && trucks.hasNextPage && !trucks.isFetchingNextPage) void trucks.fetchNextPage();
  }, [truck, trucks]);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/trucks" className="text-sm text-brand">
        ‹ Trucks
      </Link>
      {trucks.isError && <ErrorNote error={trucks.error} />}
      {!truck && (trucks.isLoading || trucks.hasNextPage) && <p className="text-sm text-mute">Loading…</p>}
      {!truck && trucks.isSuccess && !trucks.hasNextPage && <Note>That truck isn't on this account.</Note>}
      {truck && <Body key={truck.id} truck={truck} />}
    </div>
  );
}

function Body({ truck }: { truck: Truck }) {
  const canWrite = canDispatch(useSession()?.role);
  const [values, setValues] = useState<TruckFormValues>(() => truckToForm(truck));
  const update = useUpdateTruck();
  const result = truckBody(values, 'update');

  return (
    <>
      <h1 className="text-2xl">{truck.label}</h1>
      {!truck.active && <Note>Out of service. It can't be assigned to a load until it's back in.</Note>}

      {canWrite ? (
        <>
          <TruckForm values={values} onChange={setValues} />
          {'invalid' in result && values.label.trim() && <p className="text-sm text-bad">{result.invalid} needs a whole number.</p>}
          <button
            type="button"
            className="hq-btn hq-btn-brand w-full"
            disabled={!('body' in result) || update.isPending}
            onClick={() => 'body' in result && update.mutate({ id: truck.id, body: result.body }, { onSuccess: successFeedback })}
          >
            {update.isPending ? 'Saving…' : 'Save changes'}
          </button>
          {update.isSuccess && !update.isPending && <p className="text-center text-sm text-ok">Saved.</p>}
          <ErrorNote error={update.error} />
          <MotiveMatch truck={truck} />
          <ActiveControl truck={truck} />
        </>
      ) : (
        <Note>Only an owner or dispatcher can change trucks.</Note>
      )}
    </>
  );
}

/**
 * The Motive vehicle this truck is, picked by the fleet's own number, never
 * a raw id. Carriers without Motive don't see this at all.
 */
function MotiveMatch({ truck }: { truck: Truck }) {
  const motive = useMotiveVehicles();
  const match = useSetMotiveVehicle();
  if (motive.isError && isMotiveNotConnected(motive.error)) return null;
  if (motive.isError) return <ErrorNote error={motive.error} />;
  if (!motive.data) return null;

  return (
    <Card title="Motive">
      <Field label="Which Motive vehicle this is" hint="Its position then syncs on its own.">
        <select
          className="hq-input"
          value={truck.motiveVehicleId === null ? '' : String(truck.motiveVehicleId)}
          disabled={match.isPending}
          onChange={(e) => match.mutate({ truckId: truck.id, motiveVehicleId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Not matched</option>
          {motive.data.vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.number}
              {v.vin ? ` · …${v.vin.slice(-6)}` : ''}
            </option>
          ))}
        </select>
      </Field>
      <ErrorNote error={match.error} />
    </Card>
  );
}

function ActiveControl({ truck }: { truck: Truck }) {
  const setActive = useSetTruckActive();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');

  if (!truck.active) {
    return (
      <>
        <button
          type="button"
          className="hq-btn hq-btn-ghost w-full"
          disabled={setActive.isPending}
          onClick={() => setActive.mutate({ id: truck.id, active: true })}
        >
          {setActive.isPending ? 'Saving…' : 'Put back in service'}
        </button>
        <ErrorNote error={setActive.error} />
      </>
    );
  }

  if (!confirming) {
    return (
      <button type="button" className="w-full py-2 text-sm text-bad" onClick={() => setConfirming(true)}>
        Take out of service
      </button>
    );
  }

  return (
    <Card title="Take out of service">
      <p className="mb-3 text-sm text-slate">It stays on its past loads. You can put it back any time.</p>
      <Field label="Why (optional)">
        <input className="hq-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Sold, in the shop…" />
      </Field>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="hq-btn flex-1 bg-bad text-white"
          disabled={setActive.isPending}
          onClick={() =>
            setActive.mutate(
              { id: truck.id, active: false, ...(reason.trim() ? { reason: reason.trim() } : {}) },
              { onSuccess: () => setConfirming(false) },
            )
          }
        >
          {setActive.isPending ? 'Saving…' : 'Take it out'}
        </button>
        <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
      <ErrorNote error={setActive.error} />
    </Card>
  );
}
