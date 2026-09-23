/**
 * One load, for owners, dispatchers and accountants. Web's `LoadDetail.tsx`
 * on a phone (MOBILE_PARITY_PLAN.md M1).
 *
 * Order is by how often each part is needed. First what's happening
 * (status, where the truck is, what it made), then acting on it (move it,
 * assign it, send links), then the occasional settings, collapsed.
 *
 * Accountants see the read-only parts, the same split web makes with
 * `canWrite`. The API enforces it either way.
 *
 * Drivers get `../LoadDetail.tsx` instead (milestones and a position ping).
 * `LoadRoute` below picks between the two.
 */

import { Link, useParams } from '@tanstack/react-router';
import { canDispatch, laneEnds, LOAD_STATUS_TONE, prettyStatus, useLoad, type Load } from '@haulq/client';
import { useSession } from '../../components/AuthGate.tsx';
import { showsTabBar } from '../../components/Shell.tsx';
import { Paperwork } from '../../components/Paperwork.tsx';
import { Card, ErrorNote, Money, Pill } from '../../components/ui.tsx';
import { LoadDetailScreen as DriverLoadDetailScreen } from '../LoadDetail.tsx';
import { BrokerSection } from './Broker.tsx';
import { FeasibilitySection } from './Feasibility.tsx';
import { CheckinCodeSection, TrackingLinkSection } from './Links.tsx';
import { MarginCard, TrackingCard } from './Progress.tsx';
import { AssignmentControl, StatusControl } from './StatusAndAssignment.tsx';
import { EditStopsSection, NearbyStopsSection } from './Stops.tsx';

/** `/loads/$loadId`: the office screen for office roles, the milestone screen for drivers. */
export function LoadRoute() {
  const role = useSession()?.role;
  return showsTabBar(role) ? <OfficeLoadScreen /> : <DriverLoadDetailScreen />;
}

function OfficeLoadScreen() {
  const { loadId } = useParams({ from: '/loads/$loadId' });
  const session = useSession();
  const load = useLoad(loadId);
  const canWrite = canDispatch(session?.role);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/" className="text-sm text-brand">
        ‹ Loads
      </Link>

      {load.isError && <ErrorNote error={load.error} />}
      {load.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {load.data && <Body load={load.data} canWrite={canWrite} />}
    </div>
  );
}

function Body({ load, canWrite }: { load: Load; canWrite: boolean }) {
  const { pickup, delivery } = laneEnds(load.stops);

  return (
    <>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="num text-2xl">Load {load.reference}</h1>
          <Pill tone={LOAD_STATUS_TONE[load.status] ?? 'neutral'} onPage>
            {prettyStatus(load.status)}
          </Pill>
        </div>
        <p className="text-slate">
          {load.brokerName ?? 'No broker'}
          {load.brokerLoadNumber && <span className="text-mute"> · #{load.brokerLoadNumber}</span>}
        </p>
        <p>
          {pickup ? `${pickup.city}, ${pickup.state}` : '—'}
          <span className="text-mute"> → </span>
          {delivery ? `${delivery.city}, ${delivery.state}` : '—'}
        </p>
        <p className="text-sm text-mute">
          {load.rateAmount !== null ? <Money cents={load.rateAmount} /> : 'No rate'}
          {load.commodity && ` · ${load.commodity}`}
          {load.weightLbs !== null && ` · ${load.weightLbs.toLocaleString()} lbs`}
        </p>
        {load.cancelledReason && <p className="text-sm text-warn">Cancelled: {load.cancelledReason}</p>}
      </header>

      {canWrite && (
        <Card title="Status and assignment">
          <div className="space-y-4">
            <StatusControl load={load} />
            <div className="border-t border-line pt-4">
              <AssignmentControl load={load} />
            </div>
          </div>
        </Card>
      )}

      <TrackingCard loadId={load.id} />
      <MarginCard loadId={load.id} />
      <Paperwork loadId={load.id} forDriver={false} />

      {canWrite && (
        <>
          <TrackingLinkSection load={load} />
          <CheckinCodeSection load={load} />
          <EditStopsSection key={load.id} load={load} />
          <FeasibilitySection load={load} />
          <NearbyStopsSection load={load} />
          {load.brokerId && load.brokerName && (
            <BrokerSection key={load.brokerId} load={{ ...load, brokerId: load.brokerId, brokerName: load.brokerName }} />
          )}
        </>
      )}
    </>
  );
}
