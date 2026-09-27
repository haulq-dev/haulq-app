/**
 * One driver: call or text them, correct their details and credentials,
 * invite them to the app, or take them off the roster. Also the "Add a
 * driver" screen (`/drivers/new`), which is the same form.
 *
 * Editing is new: web can only add a driver. `PATCH /v1/drivers/:id` was
 * added with this screen, mainly so a renewed CDL or medical card can be
 * recorded and the out-of-service warning stops.
 *
 * Removing is a soft delete, so past loads keep the name they ran under.
 * The API refuses while the driver is on a booked, dispatched or in-transit
 * load, and says which one.
 *
 * Like trucks, there's no single-driver GET, so the driver comes from the
 * list cache.
 */

import {
  canDispatch,
  CREDENTIAL_LABEL,
  credentialState,
  driverBody,
  driverToForm,
  EMPTY_DRIVER_FORM,
  useCreateDriver,
  useDriverList,
  useInvite,
  useRemoveDriver,
  useTrucks,
  useUpdateDriver,
  type Driver,
  type DriverFormValues,
} from '@haulq/client';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { InviteLink } from '../../components/InviteLink.tsx';
import { Card, ErrorNote, Field, Note } from '../../components/ui.tsx';
import { successFeedback } from '../../lib/haptics.ts';
import { DriverForm } from './DriverForm.tsx';
import { credentialDate } from './shared.ts';

function useActiveTrucks() {
  const trucks = useTrucks();
  return (trucks.data?.items ?? []).filter((t) => t.active);
}

export function NewDriverScreen() {
  const navigate = useNavigate();
  const trucks = useActiveTrucks();
  const [values, setValues] = useState<DriverFormValues>(EMPTY_DRIVER_FORM);
  const create = useCreateDriver();
  const result = driverBody(values, 'create');

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/drivers" className="text-sm text-brand">
        ‹ Drivers
      </Link>
      <h1 className="text-2xl">Add a driver</h1>
      <DriverForm values={values} onChange={setValues} trucks={trucks} />
      {'invalid' in result && result.invalid === 'State' && <p className="text-sm text-bad">State is two letters, like KS.</p>}
      <button
        type="button"
        className="hq-btn hq-btn-brand w-full"
        disabled={!('body' in result) || create.isPending}
        onClick={() =>
          'body' in result &&
          create.mutate(result.body, {
            onSuccess: (driver) => {
              successFeedback();
              void navigate({ to: '/drivers/$driverId', params: { driverId: driver.id }, replace: true });
            },
          })
        }
      >
        {create.isPending ? 'Adding…' : 'Add driver'}
      </button>
      <p className="text-center text-xs text-mute">You can invite them to the app on the next screen.</p>
      <ErrorNote error={create.error} />
    </div>
  );
}

export function DriverScreen() {
  const { driverId } = useParams({ from: '/drivers/$driverId' });
  const drivers = useDriverList();
  const driver = drivers.data?.pages.flatMap((p) => p.items).find((d) => d.id === driverId);

  useEffect(() => {
    if (!driver && drivers.hasNextPage && !drivers.isFetchingNextPage) void drivers.fetchNextPage();
  }, [driver, drivers]);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/drivers" className="text-sm text-brand">
        ‹ Drivers
      </Link>
      {drivers.isError && <ErrorNote error={drivers.error} />}
      {!driver && (drivers.isLoading || drivers.hasNextPage) && <p className="text-sm text-mute">Loading…</p>}
      {!driver && drivers.isSuccess && !drivers.hasNextPage && <Note>That driver isn't on the roster.</Note>}
      {driver && <Body key={driver.id} driver={driver} />}
    </div>
  );
}

function Body({ driver }: { driver: Driver }) {
  const canWrite = canDispatch(useSession()?.role);
  const trucks = useActiveTrucks();
  const [values, setValues] = useState<DriverFormValues>(() => driverToForm(driver));
  const update = useUpdateDriver();
  const result = driverBody(values, 'update');

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl">{driver.fullName}</h1>
        {driver.userId && <p className="text-sm text-mute">Uses the HaulQ app.</p>}
      </header>

      {driver.phone && (
        <div className="grid grid-cols-2 gap-2">
          <a href={`tel:${driver.phone}`} className="hq-btn hq-btn-primary active:scale-100">
            Call
          </a>
          <a href={`sms:${driver.phone}`} className="hq-btn hq-btn-ghost active:scale-100">
            Text
          </a>
        </div>
      )}

      <Credentials driver={driver} />

      {canWrite ? (
        <>
          <DriverForm values={values} onChange={setValues} trucks={trucks} />
          {'invalid' in result && result.invalid === 'State' && <p className="text-sm text-bad">State is two letters, like KS.</p>}
          <button
            type="button"
            className="hq-btn hq-btn-brand w-full"
            disabled={!('body' in result) || update.isPending}
            onClick={() => 'body' in result && update.mutate({ id: driver.id, body: result.body }, { onSuccess: successFeedback })}
          >
            {update.isPending ? 'Saving…' : 'Save changes'}
          </button>
          {update.isSuccess && !update.isPending && <p className="text-center text-sm text-ok">Saved.</p>}
          <ErrorNote error={update.error} />

          {!driver.userId && <InviteToApp driver={driver} />}
          <RemoveDriver driver={driver} />
        </>
      ) : (
        <Note>Only an owner or dispatcher can change drivers.</Note>
      )}
    </>
  );
}

function Credentials({ driver }: { driver: Driver }) {
  const rows = [
    ['cdl', driver.cdlExpiresAt],
    ['medical_card', driver.medicalCardExpiresAt],
  ] as const;
  return (
    <Card>
      <dl className="space-y-2">
        {rows.map(([what, iso]) => {
          const { tone, daysLeft } = credentialState(iso);
          const color = tone === 'bad' ? 'text-bad font-semibold' : tone === 'warn' ? 'text-warn font-semibold' : 'text-slate';
          return (
            <div key={what} className="flex items-baseline justify-between gap-3">
              <dt className="field-label">{CREDENTIAL_LABEL[what]}</dt>
              <dd className={`text-sm ${color}`}>
                {!iso
                  ? 'Not recorded'
                  : daysLeft !== null && daysLeft < 0
                    ? `Expired ${credentialDate(iso)}`
                    : `${credentialDate(iso)}${tone === 'warn' ? ` · ${daysLeft} days` : ''}`}
              </dd>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

/**
 * An invite linked to this roster row, so the moment they accept, the app
 * knows which loads are theirs. The email starts as the one on file.
 */
function InviteToApp({ driver }: { driver: Driver }) {
  const invite = useInvite();
  const [email, setEmail] = useState(driver.email ?? '');
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);

  if (issued) return <InviteLink email={issued.email} token={issued.token} onDone={() => setIssued(null)} />;

  return (
    <Card title="Invite to the app">
      <p className="mb-3 text-sm text-slate">They'll see their own loads and can send paperwork from the dock.</p>
      <Field label="Their email">
        <input
          className="hq-input"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <button
        type="button"
        className="hq-btn hq-btn-primary mt-3 w-full"
        disabled={!email.trim() || invite.isPending}
        onClick={() =>
          invite.mutate(
            { email: email.trim(), role: 'driver', driverId: driver.id },
            { onSuccess: (res) => setIssued({ email: res.invitation.email, token: res.token }) },
          )
        }
      >
        {invite.isPending ? 'Creating…' : 'Create invite link'}
      </button>
      <div className="mt-2">
        <ErrorNote error={invite.error} />
      </div>
    </Card>
  );
}

function RemoveDriver({ driver }: { driver: Driver }) {
  const navigate = useNavigate();
  const remove = useRemoveDriver();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="w-full py-2 text-sm text-bad" onClick={() => setConfirming(true)}>
        Take off the roster
      </button>
    );
  }

  return (
    <Card title={`Take ${driver.fullName} off the roster?`}>
      <p className="mb-3 text-sm text-slate">
        Past loads keep their name. They can't be assigned new loads.
        {driver.userId && ' Their app login stays, but shows no loads.'}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="hq-btn flex-1 bg-bad text-white"
          disabled={remove.isPending}
          onClick={() => remove.mutate(driver.id, { onSuccess: () => void navigate({ to: '/drivers', replace: true }) })}
        >
          {remove.isPending ? 'Removing…' : 'Take off'}
        </button>
        <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setConfirming(false)}>
          Keep
        </button>
      </div>
      <div className="mt-2">
        <ErrorNote error={remove.error} />
      </div>
    </Card>
  );
}
