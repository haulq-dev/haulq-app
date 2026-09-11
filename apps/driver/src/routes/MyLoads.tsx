/**
 * The loads this login can see — a driver's own assigned load(s), or the
 * whole org's for an owner/dispatcher/accountant signed in directly.
 *
 * `GET /v1/loads` is already server-scoped per role (`driverScopeFor` in
 * `apps/api/src/routes/loads.ts`) — this screen does no filtering of its
 * own, it just renders whatever comes back. A driver's common case is
 * exactly one row; the list shape holds equally for a dispatcher scrolling
 * the org's whole board.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { DeleteAccountLink, SignOutLink, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';
import { request } from '../lib/api.ts';

/**
 * The bare-minimum owner/dispatcher actions — add a truck, invite a
 * driver, add a load — needed once self-serve carrier signup meant a
 * brand-new carrier could land here with nothing else to do. Hidden from
 * a driver's own view since none of the three apply to them; the API's
 * own `requireRole(request, 'owner', 'dispatcher')` on all three routes
 * is what actually enforces it, not this check.
 */
function ManageLinks() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <Link to="/trucks/new" className="text-brand underline">
        Add a truck
      </Link>
      <Link to="/drivers/new" className="text-brand underline">
        Invite a driver
      </Link>
      <Link to="/loads/new" className="text-brand underline">
        Add a load
      </Link>
    </div>
  );
}

interface LoadStopSummary {
  seq: number;
  type: 'pickup' | 'delivery';
  city: string;
  state: string;
}

interface LoadSummary {
  id: string;
  reference: number;
  status: string;
  stops: LoadStopSummary[];
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  delivered: 'ok',
  in_transit: 'neutral',
  dispatched: 'neutral',
  cancelled: 'warn',
};

export function MyLoadsScreen() {
  const session = useSession();
  const loads = useQuery({
    queryKey: ['my-loads'],
    queryFn: () => request<{ items: LoadSummary[] }>('/v1/loads'),
  });

  const items = loads.data?.items ?? [];

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl">Your loads</h1>
        <div className="flex flex-col items-end gap-0.5">
          <SignOutLink />
          <DeleteAccountLink />
        </div>
      </div>
      {session?.orgName && <p className="-mt-2 text-sm text-mute">{session.orgName}</p>}

      {(session?.role === 'owner' || session?.role === 'dispatcher') && <ManageLinks />}

      {loads.isError && <ErrorNote error={loads.error} />}

      {loads.data && items.length === 0 && (
        <div className="hq-card p-4">
          <Empty>No loads yet.</Empty>
        </div>
      )}

      <ul className="space-y-3">
        {items.map((load) => {
          const pickup = load.stops.find((s) => s.type === 'pickup');
          const delivery = [...load.stops].reverse().find((s) => s.type === 'delivery');
          return (
            <li key={load.id}>
              <Link to="/loads/$loadId" params={{ loadId: load.id }} className="block">
                <Card>
                  <div className="flex items-center justify-between">
                    <span className="num text-lg font-semibold">Load {load.reference}</span>
                    <Pill tone={STATUS_TONE[load.status] ?? 'neutral'}>
                      {load.status.replace('_', ' ')}
                    </Pill>
                  </div>
                  <p className="mt-1 text-sm text-slate">
                    {pickup ? `${pickup.city}, ${pickup.state}` : '—'}
                    <span className="text-mute"> → </span>
                    {delivery ? `${delivery.city}, ${delivery.state}` : '—'}
                  </p>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
