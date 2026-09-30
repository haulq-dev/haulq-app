/**
 * Drivers, and the two dates that put one out of service.
 *
 * Drivers are not users. Most drivers at a small carrier never sign in, but a
 * load still has to be assigned to one — which is why this is a separate record
 * from the People screen, with `userId` as the optional link for the few who do
 * log in.
 *
 * The expiring-credentials strip at the top is the reason this screen earns its
 * place before there is any notification system. An expired medical card is not
 * a paperwork problem, it is a truck that cannot legally move, and the carrier
 * currently finds out from a wall calendar or from the roadside.
 *
 * Built on `@haulq/client`'s fleet helpers and hooks, the same ones the mobile
 * app uses, so the two can't disagree about what a form sends or what counts as
 * expiring. Editing and removing a driver arrived with them
 * (`PATCH`/`DELETE /v1/drivers/:id`): before, a renewed CDL or medical card
 * could not be recorded, and the out-of-service warning kept firing.
 */

import {
  canDispatch,
  CREDENTIAL_LABEL,
  credentialState,
  driverBody,
  driverToForm,
  EMPTY_DRIVER_FORM,
  ENDORSEMENT_LABEL,
  ENDORSEMENTS,
  useCreateDriver,
  useDriverList,
  useExpiringCredentials,
  useRemoveDriver,
  useTrucks,
  useUpdateDriver,
  type Driver,
  type DriverFormValues,
  type Endorsement,
  type Truck,
} from '@haulq/client';
import { useState } from 'react';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, LoadMore, Pill } from '../components/ui.tsx';

/** Read in UTC, the way the date was written (noon UTC), so no zone shows the day before. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** A credential date, coloured by how close it is, and said in words too. */
function ExpiryCell({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-mute">Not recorded</span>;
  const { tone, daysLeft } = credentialState(iso);
  const color = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-slate';
  const suffix = tone === 'bad' ? ' · expired' : tone === 'warn' ? ` · ${daysLeft}d` : '';
  return (
    <span className={`text-sm ${color}`}>
      {formatDate(iso)}
      {suffix}
    </span>
  );
}

function ExpiringStrip({ onOpen }: { onOpen: (driverId: string) => void }) {
  const expiring = useExpiringCredentials();
  const items = expiring.data ?? [];
  if (items.length === 0) return null;
  const anyExpired = items.some((i) => credentialState(i.expiresAt).tone === 'bad');

  return (
    <div className={`border-l-2 p-4 ${anyExpired ? 'border-bad bg-bad-50' : 'border-warn bg-warn-50'}`} role="alert">
      <p className={`field-label ${anyExpired ? 'text-bad' : 'text-warn'}`}>{anyExpired ? 'Out of service' : 'Expiring within 30 days'}</p>
      <ul className="mt-2 space-y-1">
        {items.map((item) => {
          const { daysLeft } = credentialState(item.expiresAt);
          return (
            <li key={`${item.driverId}-${item.what}`} className="text-sm text-slate">
              <button type="button" className="font-semibold underline" onClick={() => onOpen(item.driverId)}>
                {item.driverName}
              </button>{' '}
              — {CREDENTIAL_LABEL[item.what]}{' '}
              {daysLeft !== null && daysLeft < 0 ? `expired ${formatDate(item.expiresAt)}` : `expires ${formatDate(item.expiresAt)} (${daysLeft}d)`}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-mute">
        A lapsed CDL or medical card puts the driver out of service. Renewed? Open the driver and update the date.
      </p>
    </div>
  );
}

/** The fields adding and editing share. */
function DriverFields({ values, onChange, trucks }: { values: DriverFormValues; onChange: (v: DriverFormValues) => void; trucks: readonly Truck[] }) {
  const set = (patch: Partial<DriverFormValues>) => onChange({ ...values, ...patch });
  const toggle = (key: Endorsement, on: boolean) =>
    set({ endorsements: on ? [...values.endorsements, key] : values.endorsements.filter((e) => e !== key) });

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Full name">
          <input className="hq-input" value={values.fullName} onChange={(e) => set({ fullName: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input className="hq-input" type="tel" value={values.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Email" hint="Only if they will sign in.">
          <input className="hq-input" type="email" value={values.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
      </div>

      <fieldset className="mt-6">
        <legend className="field-label mb-1 text-slate">Licence</legend>
        <p className="mb-3 max-w-prose text-sm text-slate">Both dates below drive the out-of-service warning. Leaving them blank means nothing will warn you.</p>
        <div className="grid gap-5 sm:grid-cols-4">
          <Field label="CDL number">
            <input className="hq-input" value={values.cdlNumber} onChange={(e) => set({ cdlNumber: e.target.value })} />
          </Field>
          <Field label="State" hint="Two letters.">
            <input className="hq-input" maxLength={2} value={values.cdlState} onChange={(e) => set({ cdlState: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="CDL expires">
            <input className="hq-input" type="date" value={values.cdlExpiresAt} onChange={(e) => set({ cdlExpiresAt: e.target.value })} />
          </Field>
          <Field label="Medical card expires">
            <input
              className="hq-input"
              type="date"
              value={values.medicalCardExpiresAt}
              onChange={(e) => set({ medicalCardExpiresAt: e.target.value })}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="field-label mb-1 text-slate">Endorsements</legend>
        <p className="mb-3 max-w-prose text-sm text-slate">
          Matched against requirements read out of broker comments — “TWIC required for port pickup” is the usual case, and no numeric filter on any
          load board catches it.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {ENDORSEMENTS.map((key) => (
            <label key={key} className="flex cursor-pointer items-center gap-2.5 border border-line p-2.5 hover:border-ink">
              <input
                type="checkbox"
                className="accent-[--color-brand]"
                checked={values.endorsements.includes(key)}
                onChange={(e) => toggle(key, e.target.checked)}
              />
              <span className="text-sm font-medium">{ENDORSEMENT_LABEL[key]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {trucks.length > 0 && (
        <div className="mt-6 max-w-sm">
          <Field label="Usual truck" hint="Can be changed per load.">
            <select className="hq-input" value={values.defaultTruckId} onChange={(e) => set({ defaultTruckId: e.target.value })}>
              <option value="">No default</option>
              {trucks.map((truck) => (
                <option key={truck.id} value={truck.id}>
                  {truck.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
    </>
  );
}

function StateHint({ values }: { values: DriverFormValues }) {
  const result = driverBody(values, 'create');
  return 'invalid' in result && result.invalid === 'State' ? <p className="mt-3 text-sm text-bad">State is two letters, like KS.</p> : null;
}

function AddDriver({ trucks, onDone }: { trucks: Truck[]; onDone: () => void }) {
  const [values, setValues] = useState<DriverFormValues>(EMPTY_DRIVER_FORM);
  const create = useCreateDriver();
  const result = driverBody(values, 'create');

  return (
    <Card title="Add a driver">
      <DriverFields values={values} onChange={setValues} trucks={trucks} />
      <StateHint values={values} />
      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!('body' in result) || create.isPending}
          onClick={() => 'body' in result && create.mutate(result.body, { onSuccess: onDone })}
        >
          {create.isPending ? 'Adding…' : 'Add driver'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNote error={create.error} />
    </Card>
  );
}

/**
 * Edit a driver, or take them off the roster. Removing is a soft delete —
 * past loads keep the name they ran under — and the API refuses it while the
 * driver is on a booked, dispatched or in-transit load, naming the load.
 */
function EditDriver({ driver, trucks, onDone }: { driver: Driver; trucks: Truck[]; onDone: () => void }) {
  const [values, setValues] = useState<DriverFormValues>(() => driverToForm(driver));
  const update = useUpdateDriver();
  const remove = useRemoveDriver();
  const result = driverBody(values, 'update');

  return (
    <Card title={`Edit ${driver.fullName}`}>
      <DriverFields values={values} onChange={setValues} trucks={trucks} />
      <StateHint values={values} />
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!('body' in result) || update.isPending}
          onClick={() => 'body' in result && update.mutate({ id: driver.id, body: result.body }, { onSuccess: onDone })}
        >
          {update.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          className="hq-btn hq-btn-ghost ml-auto text-bad"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Take ${driver.fullName} off the roster? Past loads keep their name; they can't be assigned new ones.`)) {
              remove.mutate(driver.id, { onSuccess: onDone });
            }
          }}
        >
          {remove.isPending ? 'Removing…' : 'Take off the roster'}
        </button>
      </div>
      <ErrorNote error={update.error ?? remove.error} />
    </Card>
  );
}

export function DriversScreen() {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const session = useSession();
  const orgs = useOrgs();
  const drivers = useDriverList();
  const trucks = useTrucks();

  const myRole = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  const canWrite = canDispatch(myRole);

  const truckItems = (trucks.data?.items ?? []).filter((t) => t.active);
  const truckLabel = (id: string | null) => trucks.data?.items.find((t) => t.id === id)?.label;
  const list = drivers.data?.pages.flatMap((p) => p.items) ?? [];
  const editing = list.find((d) => d.id === editingId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Drivers</h1>
          <p className="mt-1 max-w-prose text-slate">Everyone who can be assigned a load, whether or not they sign in.</p>
        </div>
        {canWrite && !adding && (
          <button className="hq-btn hq-btn-primary" onClick={() => setAdding(true)}>
            Add a driver
          </button>
        )}
      </div>

      <ExpiringStrip onOpen={(id) => canWrite && setEditingId(id)} />

      {adding && <AddDriver trucks={truckItems} onDone={() => setAdding(false)} />}
      {editing && canWrite && <EditDriver key={editing.id} driver={editing} trucks={truckItems} onDone={() => setEditingId(null)} />}

      <Card>
        {drivers.isError && <ErrorNote error={drivers.error} />}
        {drivers.isLoading && <Empty>Loading…</Empty>}
        {drivers.data && list.length === 0 && <Empty>No drivers yet. A load cannot be assigned until one exists.</Empty>}

        {list.length > 0 && (
          <div className="overflow-x-auto">
            <table className="hq-table">
              <thead>
                <tr>
                  <th className="field-label">Driver</th>
                  <th className="field-label">CDL</th>
                  <th className="field-label">CDL expires</th>
                  <th className="field-label">Medical card</th>
                  <th className="field-label">Endorsements</th>
                  <th className="field-label">Usual truck</th>
                  {canWrite && <th className="field-label" />}
                </tr>
              </thead>
              <tbody>
                {list.map((driver) => (
                  <tr key={driver.id} className={editingId === driver.id ? 'bg-wash' : undefined}>
                    <td>
                      <span className="block font-medium">{driver.fullName}</span>
                      {driver.phone && (
                        <a className="num block text-xs text-mute hover:text-ink" href={`tel:${driver.phone}`}>
                          {driver.phone}
                        </a>
                      )}
                    </td>
                    <td className="num text-sm">
                      {driver.cdlNumber ? (
                        <>
                          {driver.cdlNumber}
                          {driver.cdlState && <span className="text-mute"> · {driver.cdlState}</span>}
                        </>
                      ) : (
                        <span className="text-mute">—</span>
                      )}
                    </td>
                    <td>
                      <ExpiryCell iso={driver.cdlExpiresAt} />
                    </td>
                    <td>
                      <ExpiryCell iso={driver.medicalCardExpiresAt} />
                    </td>
                    <td>
                      {driver.endorsements.length > 0 ? (
                        <span className="flex flex-wrap gap-1.5">
                          {driver.endorsements.map((e) => (
                            <Pill key={e}>{ENDORSEMENT_LABEL[e as Endorsement] ?? e}</Pill>
                          ))}
                        </span>
                      ) : (
                        <span className="text-mute">—</span>
                      )}
                    </td>
                    <td className="text-slate">{truckLabel(driver.defaultTruckId) ?? <span className="text-mute">—</span>}</td>
                    {canWrite && (
                      <td>
                        <button className="hq-btn hq-btn-ghost px-2 py-1 text-xs" onClick={() => setEditingId(driver.id)}>
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <LoadMore onClick={() => void drivers.fetchNextPage()} loading={drivers.isFetchingNextPage} hasMore={drivers.hasNextPage} />
      </Card>
    </div>
  );
}
