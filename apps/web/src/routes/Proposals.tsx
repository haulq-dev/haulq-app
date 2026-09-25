/**
 * Rate confirmations HaulQ has read as loads, waiting for someone to look.
 * `FEATURE_REQUESTS_PLAN.md` section 12, R2.
 *
 * Three small pieces live here because they all answer "is there something to
 * review?": the list screen, the banner on Loads that says there is, and the
 * button on a rate confirmation in the Documents inbox. The review itself is
 * `ProposalReview.tsx`.
 */

import {
  equipmentLabel,
  formatCents,
  gapSentence,
  proposalLane,
  useLoadProposals,
  useProposeLoad,
  type LoadProposalView,
} from '@haulq/client';
import { Link, useNavigate } from '@tanstack/react-router';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';
import { ApiRequestError } from '../lib/api.ts';

/** How often an open list looks again, so a rate confirmation that just arrived shows up without a refresh. */
const REFRESH_MS = 60_000;

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Whether the signed-in person can create loads: owner or dispatcher, the same two roles the API allows. */
function useCanDispatch(): boolean | undefined {
  const session = useSession();
  const orgs = useOrgs();
  if (orgs.isLoading) return undefined;
  const role = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  return role === 'owner' || role === 'dispatcher';
}

function ProposalCard({ proposal }: { proposal: LoadProposalView }) {
  const load = proposal.load;
  const lane = proposalLane(load);
  const gaps = gapSentence(proposal.gaps);
  const facts = [load.rateAmount !== undefined ? formatCents(load.rateAmount) : null, equipmentLabel(load.equipment), load.brokerName ?? null].filter(Boolean);

  return (
    <li className="border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate font-semibold">{proposal.filename ?? 'Rate confirmation'}</p>
          <p className="text-sm text-slate">{lane ?? 'Could not read where it goes.'}</p>
          {facts.length > 0 && <p className="num text-sm text-mute">{facts.join(' · ')}</p>}
          <p className="text-xs text-mute">
            {proposal.receivedFrom ? `From ${proposal.receivedFrom} · ` : ''}
            {when(proposal.receivedAt)}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {proposal.matchedLoad && <Pill tone="warn">Load {proposal.matchedLoad.reference} has this number</Pill>}
            {gaps && <span className="text-xs text-warn">{gaps}</span>}
          </div>
        </div>
        <Link to="/proposals/$proposalId" params={{ proposalId: proposal.id }} className="hq-btn hq-btn-brand">
          Review
        </Link>
      </div>
    </li>
  );
}

function UnreadableRow({ proposal }: { proposal: LoadProposalView }) {
  const propose = useProposeLoad();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border border-line bg-white p-4">
      <div className="min-w-0">
        <p className="truncate font-semibold">{proposal.filename ?? 'Rate confirmation'}</p>
        <p className="text-xs text-mute">HaulQ could not read this one as a load. {when(proposal.receivedAt)}</p>
      </div>
      <div className="space-y-1 text-right">
        <button type="button" className="hq-btn hq-btn-ghost" disabled={propose.isPending} onClick={() => propose.mutate(proposal.documentId)}>
          {propose.isPending ? 'Reading…' : 'Try again'}
        </button>
        <ErrorNote error={propose.error} />
      </div>
    </li>
  );
}

export function ProposalsScreen() {
  const canDispatch = useCanDispatch();
  const pending = useLoadProposals('pending', { enabled: canDispatch === true, refetchMs: REFRESH_MS });
  const unreadable = useLoadProposals('unreadable', { enabled: canDispatch === true });

  if (canDispatch === undefined) return <p className="text-mute">Loading…</p>;
  if (!canDispatch) {
    return (
      <div className="space-y-2">
        <h1 className="text-3xl">Rate confirmations</h1>
        <p className="text-slate">Creating a load from a rate confirmation is for owners and dispatchers.</p>
      </div>
    );
  }

  const waiting = pending.data ?? [];
  const failed = unreadable.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl">Rate confirmations</h1>
        <p className="mt-1 max-w-prose text-slate">
          When a rate confirmation arrives, by email or upload, HaulQ reads it as a load. Nothing is created until you look it over and say so.
        </p>
      </div>

      <ErrorNote error={pending.error} />
      {pending.isLoading ? (
        <p className="text-mute">Loading…</p>
      ) : waiting.length === 0 ? (
        <Empty>
          Nothing is waiting. When a rate confirmation arrives it will show up here, and you will get an email. One that arrived earlier can be read from the
          Documents screen.
        </Empty>
      ) : (
        <ul className="space-y-3" aria-label="Rate confirmations waiting">
          {waiting.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </ul>
      )}

      {failed.length > 0 && (
        <Card title="Could not be read">
          <ul className="space-y-3">
            {failed.map((p) => (
              <UnreadableRow key={p.id} proposal={p} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/**
 * On Loads: there is something to review. Says nothing when there is not, and
 * nothing to anyone who cannot create a load.
 */
export function ProposalsBanner() {
  const canDispatch = useCanDispatch();
  const pending = useLoadProposals('pending', { enabled: canDispatch === true, refetchMs: REFRESH_MS });
  const count = pending.data?.length ?? 0;
  if (!canDispatch || count === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-brand bg-brand-50 px-4 py-3">
      <p className="text-sm text-ink">
        <span className="font-semibold">
          {count} rate confirmation{count === 1 ? ' is' : 's are'} ready to become {count === 1 ? 'a load' : 'loads'}.
        </span>{' '}
        HaulQ read {count === 1 ? 'it' : 'them'}; you check and create.
      </p>
      <Link to="/proposals" className="hq-btn hq-btn-brand">
        Review
      </Link>
    </div>
  );
}

/**
 * On a rate confirmation in the Documents inbox that no load owns: review the
 * load HaulQ read from it, or ask HaulQ to read it now (for one that arrived
 * before reading existed, or whose first reading came back empty).
 */
export function RateConfirmationAction({ documentId }: { documentId: string }) {
  const canDispatch = useCanDispatch();
  const pending = useLoadProposals('pending', { enabled: canDispatch === true });
  const propose = useProposeLoad();
  const navigate = useNavigate();
  if (!canDispatch) return null;

  const existing = pending.data?.find((p) => p.documentId === documentId);
  if (existing) {
    return (
      <Link to="/proposals/$proposalId" params={{ proposalId: existing.id }} className="hq-btn hq-btn-brand py-1 text-sm">
        Review as a load
      </Link>
    );
  }

  // Not connected here is an expected state on a deployment with no reader, not a fault.
  const notSetUp = propose.error instanceof ApiRequestError && propose.error.code === 'not_configured';

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="hq-btn hq-btn-ghost py-1 text-sm"
        disabled={propose.isPending}
        onClick={() => propose.mutate(documentId, { onSuccess: (next) => void navigate({ to: '/proposals/$proposalId', params: { proposalId: next.id } }) })}
      >
        {propose.isPending ? 'Reading…' : 'Read as a load'}
      </button>
      {notSetUp ? (
        <p className="text-xs text-mute">Reading rate confirmations as loads is not set up on this deployment yet.</p>
      ) : (
        <ErrorNote error={propose.error} />
      )}
    </div>
  );
}
