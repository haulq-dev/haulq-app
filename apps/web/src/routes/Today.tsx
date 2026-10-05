/**
 * Home, once setup is done: what needs someone today.
 *
 * Until the essentials are in, home is the setup checklist (`Onboarding.tsx`),
 * because nothing else works well without them. After that, a checklist with
 * every box ticked is the wrong first screen for someone opening HaulQ every
 * morning, so home becomes this: the short list of things waiting on a
 * person, each linking to where it gets done. Setup moves to the Account menu
 * (`/setup`), still one click away for the optional steps.
 *
 * Nothing here is computed for this page. Each list is something another
 * screen already shows — pending rate confirmations (Proposals), paperwork
 * with no load (the Documents inbox), Insights' "needs attention" queue,
 * Autopilot's approvals — gathered where they're seen first. Each section
 * shows only to roles that can act on it, and only when it has something in
 * it.
 */

import {
  canDispatch,
  canReviewOutbound,
  formatCents,
  isOfficeRole,
  proposalLane,
  useDocumentCounts,
  useInsights,
  useLoadProposals,
  usePendingApprovalCount,
} from '@haulq/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, useDocumentTitle } from '../components/ui.tsx';
import { request, type OnboardingStatus } from '../lib/api.ts';
import { pretty, type Load } from './Loads.tsx';
import { OnboardingScreen } from './Onboarding.tsx';

/** How many rows a section shows before pointing at the full list. */
const VISIBLE = 5;

/** `/`: setup until the essentials are in, then Today. Drivers keep what they had. */
export function HomeScreen() {
  const session = useSession();
  const orgs = useOrgs();
  const role = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  // Same query key as `OnboardingScreen`, so the switch costs no second fetch.
  const status = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => request<OnboardingStatus>('/v1/onboarding'),
    enabled: isOfficeRole(role),
  });

  if (!isOfficeRole(role) || status.isError) return <OnboardingScreen />;
  if (!status.data) return <p className="text-mute">Loading…</p>;
  if (!status.data.ready) return <OnboardingScreen />;
  const optionalLeft = status.data.steps.filter((s) => !s.required && !s.done).length;
  return <TodayScreen role={role} optionalLeft={optionalLeft} />;
}

interface Row {
  key: string;
  text: ReactNode;
  link: ReactNode;
}

function Section({ title, rows, more }: { title: string; rows: Row[]; more?: ReactNode }) {
  if (rows.length === 0) return null;
  return (
    <Card title={title} action={<span className="num text-sm text-mute">{rows.length}</span>}>
      <ul className="divide-y divide-line">
        {rows.slice(0, VISIBLE).map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <span className="min-w-0">{row.text}</span>
            <span className="shrink-0">{row.link}</span>
          </li>
        ))}
      </ul>
      {rows.length > VISIBLE && more && <div className="mt-3 text-sm">{more}</div>}
    </Card>
  );
}

const linkClass = 'hq-btn hq-btn-ghost text-xs';

export function TodayScreen({ role, optionalLeft }: { role: string | undefined; optionalLeft: number }) {
  useDocumentTitle('Today');
  const dispatch = canDispatch(role);
  const money = isOfficeRole(role);
  const approvals = canReviewOutbound(role);

  const proposals = useLoadProposals('pending', { enabled: dispatch, refetchMs: 60_000 });
  const documents = useDocumentCounts({ enabled: dispatch });
  const insights = useInsights(30);
  const pendingApprovals = usePendingApprovalCount({ enabled: approvals });
  // Loads on their way that nobody is running yet. In transit is included: a
  // load can get there through a check-in link with no driver on record.
  const open = useQuery({
    queryKey: ['loads', 'open-unassigned'],
    queryFn: () => request<{ items: Load[] }>('/v1/loads?status=booked,dispatched,in_transit&limit=100'),
    enabled: dispatch,
  });

  const proposalRows: Row[] = (proposals.data ?? []).map((p) => ({
    key: p.id,
    text: (
      <>
        <span className="font-medium">{p.load.brokerName ?? p.filename ?? 'Rate confirmation'}</span>
        <span className="text-slate">
          {' · '}
          {proposalLane(p.load)}
          {p.load.rateAmount !== undefined ? ` · ${formatCents(p.load.rateAmount)}` : ''}
        </span>
      </>
    ),
    link: (
      <Link to="/proposals/$proposalId" params={{ proposalId: p.id }} className={linkClass}>
        Review
      </Link>
    ),
  }));

  const unattached = documents.data?.unattached ?? 0;
  // Pending rate confirmations are unattached documents too; count the rest
  // here so the same file isn't listed twice.
  const otherPaperwork = Math.max(0, unattached - proposalRows.length);

  const unassignedRows: Row[] = (open.data?.items ?? [])
    .filter((l) => !l.truckId || !l.driverId)
    .map((l) => {
      const missing = !l.truckId && !l.driverId ? 'no truck or driver' : !l.truckId ? 'no truck' : 'no driver';
      const first = l.stops.find((s) => s.type === 'pickup');
      const last = [...l.stops].reverse().find((s) => s.type === 'delivery');
      return {
        key: l.id,
        text: (
          <>
            <span className="num font-medium">Load {l.reference}</span>
            <span className="text-slate">
              {' '}
              {pretty(l.status)}, {first ? `${first.city}, ${first.state}` : '—'} → {last ? `${last.city}, ${last.state}` : '—'}
            </span>{' '}
            <span className="text-warn">{missing}</span>
          </>
        ),
        link: (
          <Link to="/loads/$loadId" params={{ loadId: l.id }} className={linkClass}>
            Assign
          </Link>
        ),
      };
    });

  const queue = money ? insights.data?.actionQueue : undefined;
  const notInvoicedRows: Row[] = (queue?.deliveredNotInvoiced ?? [])
    .slice()
    .sort((a, b) => b.daysSinceDelivered - a.daysSinceDelivered)
    .map((row) => ({
      key: row.loadId,
      text: (
        <>
          <span className="num font-medium">Load {row.reference}</span>
          <span className="text-slate">
            {row.brokerName ? ` · ${row.brokerName}` : ''} · delivered {row.daysSinceDelivered} days ago
          </span>
        </>
      ),
      link: (
        <Link to="/loads/$loadId" params={{ loadId: row.loadId }} className={linkClass}>
          Invoice it
        </Link>
      ),
    }));

  const overdueRows: Row[] = (queue?.overdueInvoices ?? [])
    .slice()
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .map((row) => ({
      key: row.invoiceId,
      text: (
        <>
          <span className="num font-medium">Invoice {row.reference}</span>
          <span className="text-slate">
            {' '}
            · load {row.loadReference}
            {row.brokerName ? ` · ${row.brokerName}` : ''} · {formatCents(row.totalCents)}
          </span>{' '}
          <span className="text-bad">{row.daysOverdue} days past due</span>
        </>
      ),
      link: (
        <Link to="/pay" search={{ invoice: row.invoiceId }} className={linkClass}>
          Open
        </Link>
      ),
    }));

  const waitingApprovals = approvals ? (pendingApprovals.data ?? 0) : 0;

  const loading = (dispatch && (proposals.isLoading || open.isLoading)) || (money && insights.isLoading);
  const nothing =
    !loading &&
    proposalRows.length + otherPaperwork + unassignedRows.length + notInvoicedRows.length + overdueRows.length + waitingApprovals === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Today</h1>
          <p className="mt-1 max-w-prose text-slate">What is waiting on someone, each linked to where it gets done.</p>
        </div>
        {optionalLeft > 0 && (
          <Link to="/setup" className="text-sm text-brand underline">
            {optionalLeft} optional setup {optionalLeft === 1 ? 'step' : 'steps'} left
          </Link>
        )}
      </div>

      <ErrorNote error={proposals.error ?? open.error ?? insights.error} />
      {loading && <Empty>Loading…</Empty>}

      {waitingApprovals > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-brand bg-brand-50 px-4 py-3">
          <span className="text-sm">
            Autopilot has <span className="num font-semibold">{waitingApprovals}</span>{' '}
            {waitingApprovals === 1 ? 'message' : 'messages'} waiting for your approval.
          </span>
          <Link to="/autopilot" className="hq-btn hq-btn-primary text-xs">
            Review
          </Link>
        </div>
      )}

      <Section
        title="Rate confirmations ready to become loads"
        rows={proposalRows}
        more={<Link to="/proposals" className="text-brand underline">All {proposalRows.length}</Link>}
      />

      {otherPaperwork > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-white px-5 py-3">
          <span className="text-sm">
            <span className="num font-semibold">{otherPaperwork}</span>{' '}
            {otherPaperwork === 1 ? 'document isn’t' : 'documents aren’t'} on a load yet.
          </span>
          <Link to="/documents" className={linkClass}>
            Open Documents
          </Link>
        </div>
      )}

      <Section
        title="Loads nobody is running yet"
        rows={unassignedRows}
        more={<Link to="/loads" className="text-brand underline">Open Loads</Link>}
      />
      <Section
        title="Delivered, not invoiced"
        rows={notInvoicedRows}
        more={<Link to="/insights" className="text-brand underline">All {notInvoicedRows.length} in Insights</Link>}
      />
      <Section
        title="Overdue invoices"
        rows={overdueRows}
        more={<Link to="/pay" search={{ status: 'sent' }} className="text-brand underline">All sent invoices</Link>}
      />

      {nothing && (
        <Card>
          <Empty>Nothing needs you right now. New rate confirmations, unassigned loads and late invoices will show up here.</Empty>
        </Card>
      )}
    </div>
  );
}
