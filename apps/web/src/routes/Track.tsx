/**
 * A broker's tracking page.
 *
 * PHASE_2_PLAN.md section 4's second sentence of the exit gate: "a broker
 * can watch it happen without an account." Reached from a link, not a menu
 * — nobody signs in to see this, so it renders outside `AuthGate`'s wall the
 * same way `Invite.tsx` does, see `main.tsx`'s `PUBLIC_PREFIXES`.
 *
 * Deliberately does not show an ETA or a detention countdown. Both are open
 * questions in PHASE_2_PLAN.md section 7 — the routing method for one, where
 * the free-time threshold lives for the other — and showing a number here
 * would be answering a question the plan says is not settled yet. What is
 * shown instead: status, each stop's own timestamps, and the truck's last
 * known position with its age, which is the part that is not in question.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ApiRequestError, request } from '../lib/api.ts';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';
import { Logo } from '../components/Logo.tsx';

interface TrackingStop {
  seq: number;
  type: 'pickup' | 'delivery';
  city: string;
  state: string;
  facilityName: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  arrivedAt: string | null;
  loadingStartedAt: string | null;
  loadingEndedAt: string | null;
  departedAt: string | null;
}

interface TrackingView {
  orgName: string;
  loadReference: number;
  status: string;
  equipment: string;
  truck: {
    label: string | null;
    currentCity: string | null;
    currentState: string | null;
    positionAt: string | null;
  } | null;
  stops: TrackingStop[];
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  delivered: 'ok',
  invoiced: 'ok',
  paid: 'ok',
  cancelled: 'warn',
};

const pretty = (s: string) => s.replace(/_/g, ' ');

/** "3 hours ago", "just now" — coarse on purpose, this is a freshness signal, not a clock. */
function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

function StopRow({ stop }: { stop: TrackingStop }) {
  const checkpoints: Array<{ label: string; at: string | null }> = [
    { label: 'Arrived', at: stop.arrivedAt },
    { label: 'Loading started', at: stop.loadingStartedAt },
    { label: 'Loading ended', at: stop.loadingEndedAt },
    { label: 'Departed', at: stop.departedAt },
  ];
  const reached = checkpoints.filter((c) => c.at);

  return (
    <li className="border-b border-line py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="field-label text-brand">
            {stop.type === 'pickup' ? 'Pickup' : 'Delivery'}
          </span>
          <p className="mt-0.5 text-lg">
            {stop.facilityName ? `${stop.facilityName} — ` : ''}
            {stop.city}, {stop.state}
          </p>
        </div>
        {stop.windowStart && (
          <span className="text-sm text-mute">Appointment {when(stop.windowStart)}</span>
        )}
      </div>

      {reached.length > 0 ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
          {checkpoints.map((c) => (
            <div key={c.label}>
              <dt className="field-label text-mute">{c.label}</dt>
              <dd className="mt-0.5 text-sm">{c.at ? when(c.at) : '—'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-mute">Not there yet.</p>
      )}
    </li>
  );
}

export function TrackScreen() {
  const { token } = useParams({ from: '/track/$token' });

  const view = useQuery({
    queryKey: ['tracking', token],
    queryFn: () => request<TrackingView>(`/v1/track/${token}`),
    retry: false,
    // A tracking page gets left open on a phone. Refetch quietly rather than
    // making the broker reload to see whether anything moved.
    refetchInterval: 60_000,
  });

  return (
    <div className="min-h-screen bg-wash">
      <header className="border-b border-line bg-white px-6 py-4">
        <Logo className="h-7" />
      </header>

      <div className="mx-auto max-w-3xl px-6 py-10">
        {view.isLoading && <p className="text-mute">Loading…</p>}

        {view.isError && (
          <Card title="This link isn't working">
            <ErrorNote
              error={
                view.error instanceof ApiRequestError
                  ? view.error
                  : new Error('That tracking link could not be checked.')
              }
            />
          </Card>
        )}

        {view.data && (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="field-label text-mute">{view.data.orgName}</p>
                <h1 className="text-3xl">Load {view.data.loadReference}</h1>
              </div>
              <Pill tone={STATUS_TONE[view.data.status] ?? 'neutral'}>
                {pretty(view.data.status)}
              </Pill>
            </div>

            <Card title="Last known position">
              {view.data.truck ? (
                <div>
                  <p className="text-lg">{view.data.truck.label}</p>
                  {view.data.truck.currentCity ? (
                    <p className="mt-1 text-slate">
                      {view.data.truck.currentCity}, {view.data.truck.currentState}
                      {view.data.truck.positionAt && (
                        <span className="ml-2 text-sm text-mute">
                          {relativeAge(view.data.truck.positionAt)}
                        </span>
                      )}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-mute">No position reported yet.</p>
                  )}
                </div>
              ) : (
                <Empty>No truck assigned yet.</Empty>
              )}
            </Card>

            <div className="mt-6">
              <Card title="Stops">
                <ul>
                  {view.data.stops.map((stop) => (
                    <StopRow key={stop.seq} stop={stop} />
                  ))}
                </ul>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
