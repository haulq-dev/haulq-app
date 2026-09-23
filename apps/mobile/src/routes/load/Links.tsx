/**
 * The two links a load hands out: a broker's tracking page and a driver's
 * check-in code. Owners and dispatchers only. Both need the Fleet plan; a Core
 * org gets `ErrorNote`'s neutral "not included in your plan" text, never an
 * upgrade prompt.
 *
 * Both tokens are shown **once**. The server keeps only a hash, the same
 * contract as web. What changes on a phone is that issuing one opens the
 * share sheet straight away, since sending it is the whole point.
 *
 * The check-in code is remembered on this device per load, like web's
 * localStorage copy. An app kill mid-task would otherwise lose a code nobody
 * sent yet, and the server still can't show it again. The tracking link is
 * not remembered, matching web.
 */

import { useMutation } from '@tanstack/react-query';
import { useDrivers, type Load } from '@haulq/client';
import { useState } from 'react';
import { request } from '../../lib/api.ts';
import { shareOrCopy, WEB_ORIGIN } from '../../lib/share.ts';
import { ErrorNote, Field } from '../../components/ui.tsx';
import { Section } from './shared.tsx';

function ShareResult({ result }: { result: 'shared' | 'copied' | 'cancelled' | null }) {
  if (result === 'copied') return <span className="text-sm text-ok">Copied</span>;
  if (result === 'shared') return <span className="text-sm text-ok">Sent</span>;
  return null;
}

export function TrackingLinkSection({ load }: { load: Load }) {
  const [url, setUrl] = useState<string | null>(null);
  const [result, setResult] = useState<'shared' | 'copied' | 'cancelled' | null>(null);

  const share = async (link: string) =>
    setResult(
      await shareOrCopy({
        title: `Tracking for load ${load.reference}`,
        text: `Live tracking for load ${load.brokerLoadNumber ?? load.reference}:`,
        url: link,
      }),
    );

  const issue = useMutation({
    mutationFn: () => request<{ token: string }>(`/v1/loads/${load.id}/visibility-links`, { method: 'POST' }),
    onSuccess: async (res) => {
      const link = `${WEB_ORIGIN}/track/${res.token}`;
      setUrl(link);
      await share(link);
    },
  });

  const revoke = useMutation({
    mutationFn: () => request(`/v1/loads/${load.id}/visibility-links`, { method: 'DELETE' }),
    onSuccess: () => {
      setUrl(null);
      setResult(null);
    },
  });

  return (
    <Section title="Broker tracking link">
      <p className="text-sm text-slate">A page the broker can open without a HaulQ account, showing status, last position and ETA.</p>
      {url ? (
        <>
          <p className="text-xs text-mute">Shown only once. Send it now.</p>
          <code className="block break-all rounded-[var(--radius-sm)] bg-wash px-3 py-2 text-xs">{url}</code>
          <div className="flex items-center gap-2">
            <button type="button" className="hq-btn hq-btn-brand" onClick={() => void share(url)}>
              Share
            </button>
            <ShareResult result={result} />
          </div>
          <button type="button" className="text-sm text-bad underline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {revoke.isPending ? 'Revoking…' : 'Revoke this link'}
          </button>
        </>
      ) : (
        <button type="button" className="hq-btn hq-btn-brand" disabled={issue.isPending} onClick={() => issue.mutate()}>
          {issue.isPending ? 'Creating…' : 'Create and share'}
        </button>
      )}
      <ErrorNote error={issue.error ?? revoke.error} />
    </Section>
  );
}

interface IssuedCheckin {
  token: string;
  driverId: string | null;
}

const checkinKey = (loadId: string) => `haulq.checkinCode.${loadId}`;

function storedCheckin(loadId: string): IssuedCheckin | null {
  try {
    const raw = localStorage.getItem(checkinKey(loadId));
    return raw ? (JSON.parse(raw) as IssuedCheckin) : null;
  } catch {
    return null;
  }
}

export function CheckinCodeSection({ load }: { load: Load }) {
  const drivers = useDrivers();
  const [issued, setIssued] = useState<IssuedCheckin | null>(() => storedCheckin(load.id));
  const [driverId, setDriverId] = useState(load.driverId ?? '');
  const [result, setResult] = useState<'shared' | 'copied' | 'cancelled' | null>(null);

  const share = async (token: string) =>
    setResult(
      await shareOrCopy({
        title: `Check-in code for load ${load.reference}`,
        text: `Your HaulQ check-in code for load ${load.reference}: ${token}\nOpen the HaulQ app, tap "Have a check-in code instead?" and enter it.`,
      }),
    );

  const issue = useMutation({
    mutationFn: () =>
      request<{ token: string; link: { driverId: string | null } }>(`/v1/loads/${load.id}/checkin-links`, {
        method: 'POST',
        body: driverId ? { driverId } : {},
      }),
    onSuccess: async (res) => {
      const record = { token: res.token, driverId: res.link.driverId };
      try {
        localStorage.setItem(checkinKey(load.id), JSON.stringify(record));
      } catch {
        // Storage off: the code still works, it just won't survive an app kill.
      }
      setIssued(record);
      await share(res.token);
    },
  });

  const revoke = useMutation({
    mutationFn: () => request(`/v1/loads/${load.id}/checkin-links`, { method: 'DELETE' }),
    onSuccess: () => {
      try {
        localStorage.removeItem(checkinKey(load.id));
      } catch {
        // Nothing stored.
      }
      setIssued(null);
      setResult(null);
    },
  });

  const forDriver = issued?.driverId ? drivers.data?.items.find((d) => d.id === issued.driverId) : undefined;

  return (
    <Section title="Driver check-in code" summary={issued ? 'issued' : undefined}>
      <p className="text-sm text-slate">
        For a driver without a HaulQ login. They enter it in the app to report arrival, loading and departure.
      </p>
      {issued ? (
        <>
          {forDriver && (
            <p className="text-sm">
              For <span className="font-medium">{forDriver.fullName}</span>
              {forDriver.phone && <span className="text-mute"> · {forDriver.phone}</span>}
            </p>
          )}
          <code className="num block break-all rounded-[var(--radius-sm)] bg-wash px-3 py-2 text-base">{issued.token}</code>
          <div className="flex items-center gap-2">
            <button type="button" className="hq-btn hq-btn-brand" onClick={() => void share(issued.token)}>
              Share
            </button>
            <ShareResult result={result} />
          </div>
          <button type="button" className="text-sm text-bad underline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {revoke.isPending ? 'Revoking…' : 'Revoke this code'}
          </button>
        </>
      ) : (
        <>
          <Field label="Code is for" hint="Optional. Leave unassigned if you don't know who yet.">
            <select className="hq-input" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">Not assigned yet</option>
              {(drivers.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="hq-btn hq-btn-brand" disabled={issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? 'Creating…' : 'Create and share'}
          </button>
        </>
      )}
      <ErrorNote error={issue.error ?? revoke.error} />
    </Section>
  );
}
