/**
 * The driver check-in screen.
 *
 * PHASE_2_PLAN.md section 4's exit gate, the driver's half: "a driver can
 * report arrival, loading and departure without a phone call." One screen,
 * reached by a link — no sign-in, no menu, nothing to configure. The token
 * in the URL is the only thing that says which load this is.
 *
 * No ordering enforced between the four checkpoints, matching
 * `recordStopCheckin`'s own design: a driver taps whichever button matches
 * what just happened, and a spotty connection means "loading started" can
 * legitimately arrive after "departed" already went through. Once a
 * checkpoint is set it becomes a stamp, not a toggle — correcting a bad tap
 * is a fast-follow, not this pass.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Geolocation } from '@capacitor/geolocation';
import { useEffect, useState } from 'react';
import { STOP_MILESTONES, type StopMilestone } from '@haulq/contracts';
import {
  ApiRequestError,
  request,
  type CheckinPreview,
  type CheckinStop,
} from '../lib/api.ts';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';
import { Logo } from '../components/Logo.tsx';

/** How often the app pings a position while this screen is open. Foreground
 *  only — continuous background tracking is what an ELD buys (2b), not this
 *  tier. See PHASE_2_PLAN.md section 4. */
const POSITION_PING_MS = 5 * 60_000;

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

const MILESTONE_COLUMN: Record<StopMilestone, keyof CheckinStop> = {
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

/** Extracts a token from a pasted link or a bare code — a driver copying a
 *  text message rarely strips the URL down to just the token. */
function tokenFromInput(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? trimmed;
  } catch {
    return trimmed;
  }
}

function TokenEntry({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="mb-2 text-3xl">HaulQ Driver</h1>
      <p className="mb-6 text-slate">
        Paste the check-in link your dispatcher sent, or the code from it.
      </p>
      <input
        className="hq-input"
        placeholder="Check-in link or code"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <button
        className="hq-btn hq-btn-brand mt-4"
        disabled={!value.trim()}
        onClick={() => onSubmit(tokenFromInput(value))}
      >
        Continue
      </button>
    </div>
  );
}

function StopCard({ token, stop }: { token: string; stop: CheckinStop }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<StopMilestone | null>(null);

  const tap = useMutation({
    mutationFn: (milestone: StopMilestone) => {
      setPending(milestone);
      return request(`/checkin/${token}/stops/${stop.id}`, {
        method: 'POST',
        body: { milestone },
      });
    },
    onSettled: () => setPending(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['checkin', token] }),
  });

  return (
    <li className="border-b border-line py-4 last:border-b-0">
      <span className="field-label text-brand">
        {stop.type === 'pickup' ? 'Pickup' : 'Delivery'}
      </span>
      <p className="mt-0.5 text-xl">
        {stop.facilityName ? `${stop.facilityName} — ` : ''}
        {stop.city}, {stop.state}
      </p>
      {stop.windowStart && (
        <p className="mt-0.5 text-sm text-mute">Appointment {when(stop.windowStart)}</p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {STOP_MILESTONES.map((milestone) => {
          const at = stop[MILESTONE_COLUMN[milestone]] as string | null;
          if (at) {
            return (
              <div key={milestone} className="hq-btn hq-btn-done" aria-disabled="true">
                <span>
                  {MILESTONE_LABEL[milestone]}
                  <span className="block text-xs opacity-80">{when(at)}</span>
                </span>
              </div>
            );
          }
          return (
            <button
              key={milestone}
              className="hq-btn hq-btn-ghost"
              disabled={tap.isPending}
              onClick={() => tap.mutate(milestone)}
            >
              {pending === milestone && tap.isPending ? 'Sending…' : MILESTONE_LABEL[milestone]}
            </button>
          );
        })}
      </div>
      <ErrorNote error={tap.error} />
    </li>
  );
}

function PositionControl({ token }: { token: string }) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<unknown>(null);

  const sendPosition = async () => {
    setStatus('sending');
    setError(null);
    try {
      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: false });
      await request(`/checkin/${token}/position`, {
        method: 'POST',
        body: { lat: position.coords.latitude, lng: position.coords.longitude },
      });
      setStatus('sent');
    } catch (err) {
      setError(err);
      setStatus('error');
    }
  };

  // Foreground-only ping while this screen stays open. Cleared on unmount —
  // there is no background task here, on purpose. See the module note.
  useEffect(() => {
    const id = setInterval(() => void sendPosition(), POSITION_PING_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <Card title="Location">
      <button
        className="hq-btn hq-btn-primary"
        disabled={status === 'sending'}
        onClick={() => void sendPosition()}
      >
        {status === 'sending' ? 'Sending…' : 'Send my location now'}
      </button>
      {status === 'sent' && <p className="mt-2 text-sm text-ok">Location sent.</p>}
      <ErrorNote error={error} />
    </Card>
  );
}

function CheckinView({ token }: { token: string }) {
  const preview = useQuery({
    queryKey: ['checkin', token],
    queryFn: () => request<CheckinPreview>(`/checkin/${token}`),
    retry: false,
  });

  if (preview.isLoading) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center text-mute">Loading your load…</div>
    );
  }

  if (preview.isError) {
    const explanation =
      preview.error instanceof ApiRequestError
        ? preview.error.explanation
        : 'That link could not be checked.';
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="mb-2 text-2xl">This link isn't working</h1>
        <p className="text-slate">{explanation}</p>
      </div>
    );
  }

  const data = preview.data!;

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl">Load {data.loadReference}</h1>
        <Pill tone={STATUS_TONE[data.status] ?? 'neutral'}>{data.status.replace('_', ' ')}</Pill>
      </div>
      {data.truckLabel && <p className="mb-4 text-sm text-mute">{data.truckLabel}</p>}

      <Card title="Stops">
        {data.stops.length === 0 ? (
          <Empty>No stops on this load.</Empty>
        ) : (
          <ul>
            {data.stops.map((stop) => (
              <StopCard key={stop.id} token={token} stop={stop} />
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4">
        <PositionControl token={token} />
      </div>
    </div>
  );
}

function tokenFromPath(): string | null {
  const match = /^\/checkin\/([^/]+)/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function CheckinScreen() {
  const [token, setToken] = useState<string | null>(() => tokenFromPath());

  const chooseToken = (t: string) => {
    window.history.pushState(null, '', `/checkin/${encodeURIComponent(t)}`);
    setToken(t);
  };

  return (
    <div className="min-h-screen bg-wash">
      <header className="border-b border-line bg-white px-4 py-3">
        <Logo />
      </header>
      {token ? <CheckinView token={token} /> : <TokenEntry onSubmit={chooseToken} />}
    </div>
  );
}
