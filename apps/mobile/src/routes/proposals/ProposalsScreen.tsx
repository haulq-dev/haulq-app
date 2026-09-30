/**
 * Rate confirmations HaulQ has read as loads, waiting for someone to look.
 * Web's `Proposals.tsx` on a phone (FEATURE_REQUESTS_PLAN.md section 12, R2).
 *
 * Three pieces, because they all answer "is there something to review?":
 * this list, the banner on Loads that says there is, and the button on a rate
 * confirmation in Documents. The review itself is `ProposalScreen.tsx`.
 *
 * Owners and dispatchers only, the two roles the API lets create a load.
 * The banner and the button say nothing to anyone else.
 */

import {
  canDispatch,
  equipmentLabel,
  formatCents,
  gapSentence,
  proposalLane,
  useLoadProposals,
  useProposeLoad,
  type LoadProposalView,
} from '@haulq/client';
import { Link, useNavigate } from '@tanstack/react-router';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Note, Pill } from '../../components/ui.tsx';
import { ApiRequestError } from '../../lib/api.ts';

/** How often an open list looks again, so one that just arrived shows up without a pull. */
const REFRESH_MS = 60_000;

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function ProposalsScreen() {
  const allowed = canDispatch(useSession()?.role);
  const pending = useLoadProposals('pending', { enabled: allowed, refetchMs: REFRESH_MS });
  const unreadable = useLoadProposals('unreadable', { enabled: allowed });
  const waiting = pending.data ?? [];
  const failed = unreadable.data ?? [];

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/" className="text-sm text-brand">
        ‹ Loads
      </Link>
      <h1 className="text-2xl">Rate confirmations</h1>

      {!allowed ? (
        <Note>Creating a load from a rate confirmation is for owners and dispatchers.</Note>
      ) : (
        <>
          <p className="text-sm text-slate">
            When a rate confirmation arrives, by email or upload, HaulQ reads it as a load. Nothing is created until you look it over and say so.
          </p>

          <ErrorNote error={pending.error} />
          {pending.isLoading && <p className="text-sm text-mute">Loading…</p>}
          {pending.isSuccess && waiting.length === 0 && (
            <div className="hq-card px-4">
              <Empty>Nothing is waiting. A rate confirmation that arrived earlier can be read from its screen in Documents.</Empty>
            </div>
          )}
          <ul className="space-y-3" aria-label="Rate confirmations waiting">
            {waiting.map((p) => (
              <li key={p.id}>
                <ProposalCard proposal={p} />
              </li>
            ))}
          </ul>

          {failed.length > 0 && (
            <Card title="Could not be read">
              <ul className="divide-y divide-line">
                {failed.map((p) => (
                  <UnreadableRow key={p.id} proposal={p} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: LoadProposalView }) {
  const load = proposal.load;
  const gaps = gapSentence(proposal.gaps);
  const facts = [load.rateAmount !== undefined ? formatCents(load.rateAmount) : null, equipmentLabel(load.equipment), load.brokerName ?? null].filter(Boolean);

  return (
    <Link to="/proposals/$proposalId" params={{ proposalId: proposal.id }} className="block">
      <Card>
        <p className="truncate font-semibold">{proposal.filename ?? 'Rate confirmation'}</p>
        <p className="text-[0.9375rem]">{proposalLane(load) ?? 'Could not read where it goes.'}</p>
        {facts.length > 0 && <p className="num text-sm text-mute">{facts.join(' · ')}</p>}
        <p className="text-xs text-mute">
          {proposal.receivedFrom ? `From ${proposal.receivedFrom} · ` : ''}
          {when(proposal.receivedAt)}
        </p>
        {(proposal.matchedLoad || gaps) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {proposal.matchedLoad && <Pill tone="warn">Load {proposal.matchedLoad.reference} has this number</Pill>}
            {gaps && <span className="text-xs text-warn">{gaps}</span>}
          </div>
        )}
      </Card>
    </Link>
  );
}

function UnreadableRow({ proposal }: { proposal: LoadProposalView }) {
  const propose = useProposeLoad();
  return (
    <li className="space-y-2 py-3">
      <p className="truncate font-medium">{proposal.filename ?? 'Rate confirmation'}</p>
      <p className="text-xs text-mute">HaulQ could not read this one as a load. {when(proposal.receivedAt)}</p>
      <button type="button" className="hq-btn hq-btn-ghost" disabled={propose.isPending} onClick={() => propose.mutate(proposal.documentId)}>
        {propose.isPending ? 'Reading…' : 'Try again'}
      </button>
      <ErrorNote error={propose.error} />
    </li>
  );
}

/** On Loads: there is something to review. Nothing when there isn't, and nothing to a role that can't create a load. */
export function ProposalsBanner() {
  const allowed = canDispatch(useSession()?.role);
  const pending = useLoadProposals('pending', { enabled: allowed, refetchMs: REFRESH_MS });
  const count = pending.data?.length ?? 0;
  if (!allowed || count === 0) return null;

  return (
    <Link to="/proposals" className="hq-card flex items-center justify-between gap-3 bg-brand-50 px-4 py-3 shadow-none">
      <span className="text-sm">
        <span className="font-semibold">
          {count} rate confirmation{count === 1 ? ' is' : 's are'} ready to become {count === 1 ? 'a load' : 'loads'}.
        </span>{' '}
        Check and create.
      </span>
      <span className="shrink-0 font-semibold text-brand">Review ›</span>
    </Link>
  );
}

/**
 * On a rate confirmation in Documents that no load owns: review the load
 * HaulQ read from it, or ask HaulQ to read it now (one that arrived before
 * reading existed, or whose first reading came back empty).
 */
export function RateConfirmationAction({ documentId }: { documentId: string }) {
  const allowed = canDispatch(useSession()?.role);
  const pending = useLoadProposals('pending', { enabled: allowed });
  const propose = useProposeLoad();
  const navigate = useNavigate();
  if (!allowed) return null;

  const existing = pending.data?.find((p) => p.documentId === documentId);
  if (existing) {
    return (
      <Link to="/proposals/$proposalId" params={{ proposalId: existing.id }} className="hq-btn hq-btn-brand w-full active:scale-100">
        Review as a load
      </Link>
    );
  }

  // Not set up here is an expected state on a deployment with no reader, not a fault.
  const notSetUp = propose.error instanceof ApiRequestError && propose.error.code === 'not_configured';

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="hq-btn hq-btn-primary w-full"
        disabled={propose.isPending}
        onClick={() =>
          propose.mutate(documentId, {
            onSuccess: (next) => void navigate({ to: '/proposals/$proposalId', params: { proposalId: next.id } }),
          })
        }
      >
        {propose.isPending ? 'Reading…' : 'Read as a load'}
      </button>
      {notSetUp ? <Note>Reading rate confirmations as loads isn’t set up on HaulQ’s side yet.</Note> : <ErrorNote error={propose.error} />}
    </div>
  );
}
