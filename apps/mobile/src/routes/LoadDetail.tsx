/**
 * One assigned load — stop milestones and a position ping, reported through
 * the signed-in driver's own account.
 *
 * Deliberately parallel to `Checkin.tsx`'s `StopCard`/`PositionControl`
 * rather than sharing them: same interaction (tap a milestone, undo within
 * the window, send a position), but pointed at the authenticated routes
 * from `apps/api/src/routes/track.ts` (`/v1/loads/:id/stops/:stopId/checkin`,
 * `/position`) instead of the anonymous `/v1/checkin/:token/...` ones —
 * different enough in what they call and what they're allowed to read
 * (this fetches via `GET /v1/loads/:id`, which 404s a load that isn't this
 * driver's) that sharing the component would mean threading a "which auth
 * mode" flag through it. `Checkin.tsx` stays untouched; see `main.tsx`'s
 * own note on why both paths exist.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Geolocation } from '@capacitor/geolocation';
import { useState } from 'react';
import { STOP_MILESTONES, type StopMilestone } from '@haulq/contracts';
import { ApiRequestError, request } from '../lib/api.ts';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';
import { successFeedback, tapFeedback } from '../lib/haptics.ts';

interface LoadStop {
  id: string;
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

interface LoadDetailResponse {
  reference: number;
  status: string;
  stops: LoadStop[];
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  delivered: 'ok',
  in_transit: 'neutral',
  dispatched: 'neutral',
  cancelled: 'warn',
};

const MILESTONE_LABEL: Record<StopMilestone, string> = {
  arrived: 'Arrived',
  loading_started: 'Loading started',
  loading_ended: 'Loading ended',
  departed: 'Departed',
};

const MILESTONE_COLUMN: Record<StopMilestone, keyof LoadStop> = {
  arrived: 'arrivedAt',
  loading_started: 'loadingStartedAt',
  loading_ended: 'loadingEndedAt',
  departed: 'departedAt',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="9" fill="currentColor" fillOpacity="0.15" />
      <path
        d="M6 10.5l2.5 2.5L14 7.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Client-side mirror of the server's real undo window — see `Checkin.tsx`'s identical constant and note. */
const CHECKIN_UNDO_WINDOW_MS = 10 * 60_000;

function StopCard({ loadId, stop }: { loadId: string; stop: LoadStop }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<StopMilestone | null>(null);
  const [undoing, setUndoing] = useState<StopMilestone | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['load', loadId] });

  const tap = useMutation({
    mutationFn: (milestone: StopMilestone) => {
      setPending(milestone);
      return request(`/v1/loads/${loadId}/stops/${stop.id}/checkin`, {
        method: 'POST',
        body: { milestone },
      });
    },
    onSettled: () => setPending(null),
    onSuccess: () => {
      successFeedback();
      invalidate();
    },
  });

  const undo = useMutation({
    mutationFn: (milestone: StopMilestone) => {
      setUndoing(milestone);
      return request(`/v1/loads/${loadId}/stops/${stop.id}/checkin/undo`, {
        method: 'POST',
        body: { milestone },
      });
    },
    onSettled: () => setUndoing(null),
    onSuccess: () => {
      tapFeedback();
      invalidate();
    },
  });

  return (
    <li className="hq-card p-4">
      <span className="field-label text-brand">{stop.type === 'pickup' ? 'Pickup' : 'Delivery'}</span>
      <p className="mt-0.5 text-xl font-semibold">
        {stop.facilityName ? `${stop.facilityName} — ` : ''}
        {stop.city}, {stop.state}
      </p>
      {stop.windowStart && <p className="mt-0.5 text-sm text-mute">Appointment {when(stop.windowStart)}</p>}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {STOP_MILESTONES.map((milestone) => {
          const at = stop[MILESTONE_COLUMN[milestone]] as string | null;
          if (at) {
            const canUndo = Date.now() - new Date(at).getTime() < CHECKIN_UNDO_WINDOW_MS;
            return (
              <div key={milestone} className="hq-btn hq-btn-done flex-col items-start" aria-disabled="true">
                <span className="flex w-full items-center gap-2">
                  <CheckIcon />
                  <span className="text-left">
                    {MILESTONE_LABEL[milestone]}
                    <span className="block text-xs opacity-70">{when(at)}</span>
                  </span>
                </span>
                {canUndo && (
                  <button
                    className="mt-1 text-xs font-medium underline opacity-80"
                    disabled={undo.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      tapFeedback();
                      undo.mutate(milestone);
                    }}
                  >
                    {undoing === milestone && undo.isPending ? 'Undoing…' : 'Tapped by mistake? Undo'}
                  </button>
                )}
              </div>
            );
          }
          return (
            <button
              key={milestone}
              className="hq-btn hq-btn-ghost"
              disabled={tap.isPending}
              onClick={() => {
                tapFeedback();
                tap.mutate(milestone);
              }}
            >
              {pending === milestone && tap.isPending ? 'Sending…' : MILESTONE_LABEL[milestone]}
            </button>
          );
        })}
      </div>
      <ErrorNote error={tap.error ?? undo.error} />
    </li>
  );
}

function PositionControl({ loadId }: { loadId: string }) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<unknown>(null);

  const sendPosition = async () => {
    setStatus('sending');
    setError(null);
    try {
      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: false });
      await request(`/v1/loads/${loadId}/position`, {
        method: 'POST',
        body: { lat: position.coords.latitude, lng: position.coords.longitude },
      });
      setStatus('sent');
      successFeedback();
    } catch (err) {
      setError(err);
      setStatus('error');
    }
  };

  return (
    <Card title="Location">
      <button
        className="hq-btn hq-btn-primary w-full"
        disabled={status === 'sending'}
        onClick={() => {
          tapFeedback();
          void sendPosition();
        }}
      >
        {status === 'sending' ? 'Sending…' : 'Send my location now'}
      </button>
      {status === 'sent' && <p className="mt-2 text-sm text-ok">Location sent.</p>}
      <ErrorNote error={error} />
    </Card>
  );
}

export function LoadDetailScreen() {
  const { loadId } = useParams({ from: '/loads/$loadId' });
  const navigate = useNavigate();

  const load = useQuery({
    queryKey: ['load', loadId],
    queryFn: () => request<LoadDetailResponse>(`/v1/loads/${loadId}`),
    retry: false,
  });

  if (load.isLoading) {
    return <div className="px-6 py-16 text-center text-mute">Loading…</div>;
  }

  if (load.isError) {
    const explanation =
      load.error instanceof ApiRequestError
        ? load.error.explanation
        : 'That load could not be loaded.';
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="mb-2 text-xl">Can&apos;t open this load</h1>
        <p className="text-slate">{explanation}</p>
        <button className="hq-btn hq-btn-ghost mt-6" onClick={() => void navigate({ to: '/' })}>
          Back to your loads
        </button>
      </div>
    );
  }

  const data = load.data!;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <button className="text-sm text-brand underline" onClick={() => void navigate({ to: '/' })}>
        ← Your loads
      </button>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl">Load {data.reference}</h1>
        <Pill tone={STATUS_TONE[data.status] ?? 'neutral'}>{data.status.replace('_', ' ')}</Pill>
      </div>

      {data.stops.length === 0 ? (
        <div className="hq-card p-4">
          <Empty>No stops on this load.</Empty>
        </div>
      ) : (
        <ul className="space-y-3">
          {data.stops.map((stop) => (
            <StopCard key={stop.id} loadId={loadId} stop={stop} />
          ))}
        </ul>
      )}

      <PositionControl loadId={loadId} />
    </div>
  );
}
