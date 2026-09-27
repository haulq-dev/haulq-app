/**
 * Drivers: everyone who can be assigned a load, whether or not they sign in.
 * Web's `Drivers.tsx` on a phone (MOBILE_PARITY_PLAN.md M4).
 *
 * The expiring-credentials strip leads, as on web. An expired CDL or medical
 * card is a truck that can't legally move, and the carrier otherwise finds
 * out from a wall calendar or at the roadside. Each name in it opens the
 * driver, where the new date can now be entered (web still can't edit one).
 */

import {
  canDispatch,
  CREDENTIAL_LABEL,
  credentialState,
  driverCredentialTone,
  useDriverList,
  useExpiringCredentials,
  type Driver,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, LoadMore, Pill } from '../../components/ui.tsx';
import { credentialDate } from './shared.ts';

export function DriversScreen() {
  const canWrite = canDispatch(useSession()?.role);
  const drivers = useDriverList();
  const list = drivers.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ More
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl">Drivers</h1>
        {canWrite && (
          <Link to="/drivers/new" className="hq-btn hq-btn-brand active:scale-100" aria-label="Add a driver">
            + Add
          </Link>
        )}
      </div>

      <ExpiringStrip />

      {drivers.isError && <ErrorNote error={drivers.error} />}
      {drivers.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {drivers.isSuccess && list.length === 0 && (
        <div className="hq-card px-4">
          <Empty>No drivers yet. A load can't be assigned until one exists.</Empty>
        </div>
      )}

      <ul className="space-y-3">
        {list.map((d) => (
          <li key={d.id}>
            <DriverCard driver={d} />
          </li>
        ))}
      </ul>
      <LoadMore onClick={() => void drivers.fetchNextPage()} loading={drivers.isFetchingNextPage} hasMore={drivers.hasNextPage} />
    </div>
  );
}

function ExpiringStrip() {
  const expiring = useExpiringCredentials();
  const items = expiring.data ?? [];
  if (items.length === 0) return null;
  const anyExpired = items.some((i) => credentialState(i.expiresAt).tone === 'bad');

  return (
    <div className={`hq-card p-4 shadow-none ${anyExpired ? 'bg-bad-50' : 'bg-warn-50'}`} role="alert">
      <p className={`font-semibold ${anyExpired ? 'text-bad' : 'text-warn'}`}>
        {anyExpired ? 'Out of service' : 'Expiring within 30 days'}
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => {
          const { daysLeft } = credentialState(item.expiresAt);
          return (
            <li key={`${item.driverId}-${item.what}`} className="text-sm text-slate">
              <Link to="/drivers/$driverId" params={{ driverId: item.driverId }} className="font-semibold underline">
                {item.driverName}
              </Link>{' '}
              · {CREDENTIAL_LABEL[item.what]}{' '}
              {daysLeft !== null && daysLeft < 0
                ? `expired ${credentialDate(item.expiresAt)}`
                : `expires ${credentialDate(item.expiresAt)}`}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-mute">A lapsed CDL or medical card puts the driver out of service. Renewed? Open them and update the date.</p>
    </div>
  );
}

function DriverCard({ driver }: { driver: Driver }) {
  const tone = driverCredentialTone(driver);
  return (
    <Link to="/drivers/$driverId" params={{ driverId: driver.id }} className="block">
      <Card>
        <div className="flex items-center justify-between gap-2">
          <span className="text-lg font-semibold">{driver.fullName}</span>
          {tone === 'bad' && <Pill tone="warn">out of service</Pill>}
          {tone === 'warn' && <Pill tone="warn">expiring</Pill>}
        </div>
        <p className="text-sm text-mute">
          {[driver.phone, driver.cdlState && `CDL ${driver.cdlState}`, driver.userId ? 'uses the app' : null].filter(Boolean).join(' · ') ||
            'No details yet'}
        </p>
      </Card>
    </Link>
  );
}
