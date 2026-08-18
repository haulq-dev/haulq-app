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
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ENDORSEMENTS,
  request,
  type Driver,
  type Endorsement,
  type ExpiringCredential,
  type Truck,
} from '../lib/api.ts';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, Pill } from '../components/ui.tsx';

const ENDORSEMENT_LABEL: Record<Endorsement, string> = {
  hazmat: 'Hazmat',
  tanker: 'Tanker',
  doubles_triples: 'Doubles / triples',
  twic: 'TWIC',
  passenger: 'Passenger',
};

const CREDENTIAL_LABEL: Record<ExpiringCredential['what'], string> = {
  cdl: 'CDL',
  medical_card: 'Medical card',
};

/**
 * A date input's value is `YYYY-MM-DD`; the API's schema is
 * `z.string().datetime()`, which requires a full UTC timestamp and rejects the
 * bare date outright. Midday UTC rather than midnight, so that rendering the
 * value back in a US timezone cannot roll it to the previous day.
 */
function toIsoDate(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T12:00:00Z`).toISOString();
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** A credential date, coloured by how close it is. */
function ExpiryCell({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-mute">Not recorded</span>;

  const left = daysUntil(iso);
  const tone =
    left < 0 ? 'text-bad' : left <= 30 ? 'text-warn' : 'text-slate';
  const suffix =
    left < 0 ? ' · expired' : left <= 30 ? ` · ${left}d` : '';

  return (
    <span className={`text-sm ${tone}`}>
      {formatDate(iso)}
      {suffix}
    </span>
  );
}

function ExpiringStrip() {
  const expiring = useQuery({
    queryKey: ['drivers', 'expiring'],
    queryFn: () => request<{ items: ExpiringCredential[] }>('/v1/drivers/expiring?days=30'),
  });

  const items = expiring.data?.items ?? [];
  if (items.length === 0) return null;

  const anyExpired = items.some((i) => daysUntil(i.expiresAt) < 0);

  return (
    <div
      className={`border-l-2 p-4 ${
        anyExpired ? 'border-bad bg-bad-50' : 'border-warn bg-warn-50'
      }`}
      role="alert"
    >
      <p className={`field-label ${anyExpired ? 'text-bad' : 'text-warn'}`}>
        {anyExpired ? 'Out of service' : 'Expiring within 30 days'}
      </p>
      <ul className="mt-2 space-y-1">
        {items.map((item) => {
          const left = daysUntil(item.expiresAt);
          return (
            <li key={`${item.driverId}-${item.what}`} className="text-sm text-slate">
              <strong>{item.driverName}</strong> — {CREDENTIAL_LABEL[item.what]}{' '}
              {left < 0
                ? `expired ${formatDate(item.expiresAt)}`
                : `expires ${formatDate(item.expiresAt)} (${left}d)`}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-mute">
        A lapsed CDL or medical card puts the driver out of service. This is a
        load that cannot be covered, not a filing task.
      </p>
    </div>
  );
}

function AddDriver({ trucks, onDone }: { trucks: Truck[]; onDone: () => void }) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [cdlNumber, setCdlNumber] = useState('');
  const [cdlState, setCdlState] = useState('');
  const [cdlExpiresAt, setCdlExpires] = useState('');
  const [medicalCardExpiresAt, setMedicalExpires] = useState('');
  const [defaultTruckId, setDefaultTruck] = useState('');
  const [endorsements, setEndorsements] = useState<Endorsement[]>([]);

  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => {
      // Converted once and held, rather than called inside each spread: a
      // second call is a second value as far as narrowing is concerned, and
      // `exactOptionalPropertyTypes` means an explicit `undefined` is not the
      // same as an omitted key.
      const cdlIso = toIsoDate(cdlExpiresAt);
      const medicalIso = toIsoDate(medicalCardExpiresAt);

      return request<Driver>('/v1/drivers', {
        body: {
          fullName,
          ...(phone ? { phone } : {}),
          ...(email ? { email } : {}),
          ...(cdlNumber ? { cdlNumber } : {}),
          ...(cdlState ? { cdlState } : {}),
          ...(cdlIso ? { cdlExpiresAt: cdlIso } : {}),
          ...(medicalIso ? { medicalCardExpiresAt: medicalIso } : {}),
          ...(defaultTruckId ? { defaultTruckId } : {}),
          endorsements,
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDone();
    },
  });

  const toggle = (key: Endorsement, on: boolean) =>
    setEndorsements((prev) =>
      on ? [...prev, key] : prev.filter((e) => e !== key),
    );

  return (
    <Card title="Add a driver">
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Full name">
          <input
            className="hq-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </Field>
        <Field label="Phone">
          <input
            className="hq-input"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
        <Field label="Email" hint="Only if they will sign in.">
          <input
            className="hq-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
      </div>

      <fieldset className="mt-6">
        <legend className="field-label mb-1 text-slate">Licence</legend>
        <p className="mb-3 max-w-prose text-sm text-slate">
          Both dates below drive the out-of-service warning. Leaving them blank
          means nothing will warn you.
        </p>
        <div className="grid gap-5 sm:grid-cols-4">
          <Field label="CDL number">
            <input
              className="hq-input"
              value={cdlNumber}
              onChange={(e) => setCdlNumber(e.target.value)}
            />
          </Field>
          <Field label="State" hint="Two letters.">
            <input
              className="hq-input"
              maxLength={2}
              value={cdlState}
              onChange={(e) => setCdlState(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="CDL expires">
            <input
              className="hq-input"
              type="date"
              value={cdlExpiresAt}
              onChange={(e) => setCdlExpires(e.target.value)}
            />
          </Field>
          <Field label="Medical card expires">
            <input
              className="hq-input"
              type="date"
              value={medicalCardExpiresAt}
              onChange={(e) => setMedicalExpires(e.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="field-label mb-1 text-slate">Endorsements</legend>
        <p className="mb-3 max-w-prose text-sm text-slate">
          Matched against requirements read out of broker comments — “TWIC
          required for port pickup” is the usual case, and no numeric filter on
          any load board catches it.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {ENDORSEMENTS.map((key) => (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-2.5 border border-line p-2.5 hover:border-ink"
            >
              <input
                type="checkbox"
                className="accent-[--color-brand]"
                checked={endorsements.includes(key)}
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
            <select
              className="hq-input"
              value={defaultTruckId}
              onChange={(e) => setDefaultTruck(e.target.value)}
            >
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

      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!fullName || create.isPending}
          onClick={() => create.mutate()}
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

export function DriversScreen() {
  const [adding, setAdding] = useState(false);
  const session = useSession();
  const orgs = useOrgs();

  const drivers = useQuery({
    queryKey: ['drivers'],
    queryFn: () => request<{ items: Driver[] }>('/v1/drivers'),
  });

  // Needed for the "usual truck" select, and cheap — the same query the Trucks
  // screen uses, so react-query serves it from cache when arriving from there.
  const trucks = useQuery({
    queryKey: ['trucks'],
    queryFn: () => request<{ items: Truck[] }>('/v1/trucks'),
  });

  const myRole = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  const canAdd = myRole === 'owner' || myRole === 'dispatcher';

  const truckLabel = (id: string | null) =>
    trucks.data?.items.find((t) => t.id === id)?.label;

  const list = drivers.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Drivers</h1>
          <p className="mt-1 max-w-prose text-slate">
            Everyone who can be assigned a load, whether or not they sign in.
          </p>
        </div>
        {canAdd && !adding && (
          <button className="hq-btn hq-btn-primary" onClick={() => setAdding(true)}>
            Add a driver
          </button>
        )}
      </div>

      <ExpiringStrip />

      {adding && (
        <AddDriver trucks={trucks.data?.items ?? []} onDone={() => setAdding(false)} />
      )}

      <Card>
        {drivers.isError && <ErrorNote error={drivers.error} />}
        {drivers.data && list.length === 0 && (
          <Empty>
            No drivers yet. A load cannot be assigned until one exists.
          </Empty>
        )}

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
                </tr>
              </thead>
              <tbody>
                {list.map((driver) => (
                  <tr key={driver.id}>
                    <td>
                      <span className="block font-medium">{driver.fullName}</span>
                      {driver.phone && (
                        <a
                          className="num block text-xs text-mute hover:text-ink"
                          href={`tel:${driver.phone}`}
                        >
                          {driver.phone}
                        </a>
                      )}
                    </td>
                    <td className="num text-sm">
                      {driver.cdlNumber ? (
                        <>
                          {driver.cdlNumber}
                          {driver.cdlState && (
                            <span className="text-mute"> · {driver.cdlState}</span>
                          )}
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
                            <Pill key={e}>
                              {ENDORSEMENT_LABEL[e as Endorsement] ?? e}
                            </Pill>
                          ))}
                        </span>
                      ) : (
                        <span className="text-mute">—</span>
                      )}
                    </td>
                    <td className="text-slate">
                      {truckLabel(driver.defaultTruckId) ?? (
                        <span className="text-mute">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
