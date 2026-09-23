/**
 * The load's broker: FMCSA verification (HaulQ Verify) and detention free
 * time. Both are broker-wide settings edited from the load you're looking at,
 * because there is no broker screen, the same reasoning as web's
 * `VerifyBroker` and `DetentionThreshold`. Owners and dispatchers only.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys, useBrokerDocumentHistory, useBrokerVerification, type Load } from '@haulq/client';
import { useState } from 'react';
import { request } from '../../lib/api.ts';
import { ErrorNote, Field, Pill } from '../../components/ui.tsx';
import { Section, useRefreshLoad, when } from './shared.tsx';

type BrokeredLoad = Load & { brokerId: string; brokerName: string };

const authorityTone = (status: string) => (status === 'Authorized' ? 'ok' : status === 'Not authorized' ? 'warn' : 'neutral');

export function BrokerSection({ load }: { load: BrokeredLoad }) {
  const info = useBrokerVerification(load.brokerId);
  const status = info.data?.verification?.operatingStatus ?? null;

  return (
    <Section title={load.brokerName} summary={status ? <Pill tone={authorityTone(status)}>{status}</Pill> : undefined}>
      <VerifyBroker brokerId={load.brokerId} />
      <div className="border-t border-line pt-3">
        <DetentionThreshold load={load} />
      </div>
      <DocumentHistoryNote brokerId={load.brokerId} />
    </Section>
  );
}

/** Never automatic, and never blocks a load on its own. */
function VerifyBroker({ brokerId }: { brokerId: string }) {
  const queryClient = useQueryClient();
  const info = useBrokerVerification(brokerId);
  const [mcNumber, setMcNumber] = useState('');
  const refetch = () => queryClient.invalidateQueries({ queryKey: queryKeys.brokerVerification(brokerId) });

  const saveDocket = useMutation({
    mutationFn: () =>
      request(`/v1/brokers/${brokerId}/docket`, { method: 'PATCH', body: { mcNumber: mcNumber.trim() || null } }),
    onSuccess: refetch,
  });
  const verify = useMutation({
    mutationFn: () => request(`/v1/brokers/${brokerId}/verify`, { method: 'POST' }),
    onSuccess: refetch,
  });

  const d = info.data;
  const onFile = d?.mcNumber ?? d?.usdotNumber ?? null;
  const status = d?.verification?.operatingStatus ?? null;

  return (
    <div className="space-y-2">
      <p className="field-label">Operating authority (FMCSA)</p>
      {onFile ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-sm">{d?.mcNumber ? `MC ${d.mcNumber}` : `DOT ${d?.usdotNumber}`}</span>
          {status ? <Pill tone={authorityTone(status)}>{status}</Pill> : <span className="text-xs text-mute">not checked yet</span>}
          <button type="button" className="hq-btn hq-btn-ghost ml-auto" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'Checking…' : status ? 'Check again' : 'Check now'}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input className="hq-input" placeholder="MC 123456" value={mcNumber} onChange={(e) => setMcNumber(e.target.value)} />
          <button type="button" className="hq-btn hq-btn-primary" disabled={saveDocket.isPending || !mcNumber.trim()} onClick={() => saveDocket.mutate()}>
            Save
          </button>
        </div>
      )}
      {!onFile && <p className="text-xs text-mute">Needed before this broker can be checked.</p>}
      {d?.verification?.checkedAt && (
        <p className="text-xs text-mute">
          Last checked {when(d.verification.checkedAt)} via {d.verification.source}.{' '}
          {d.nextRecheckDue ? <>Re-checks automatically {when(d.nextRecheckDue)}.</> : <>Automatic re-checks are off.</>}
        </p>
      )}
      <ErrorNote error={saveDocket.error ?? verify.error} />
    </div>
  );
}

function DetentionThreshold({ load }: { load: BrokeredLoad }) {
  const refresh = useRefreshLoad(load.id);
  const [value, setValue] = useState(load.brokerDetentionFreeMinutes !== null ? String(load.brokerDetentionFreeMinutes) : '');

  const save = useMutation({
    mutationFn: () =>
      request(`/v1/brokers/${load.brokerId}/detention-threshold`, {
        method: 'PATCH',
        body: { freeMinutes: value.trim() ? Number(value) : null },
      }),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-2">
      <Field label="Detention free time (minutes)" hint="Applies to every load with this broker. Blank uses the two-hour default.">
        <div className="flex gap-2">
          <input className="hq-input" inputMode="numeric" placeholder="120" value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="hq-btn hq-btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </Field>
      {save.isSuccess && !save.isPending && <p className="text-sm text-ok">Saved</p>}
      <ErrorNote error={save.error} />
    </div>
  );
}

/** Informational only; nothing in the pipeline acts on it. */
function DocumentHistoryNote({ brokerId }: { brokerId: string }) {
  const history = useBrokerDocumentHistory(brokerId);
  const h = history.data;
  if (!h || h.manualCount === 0) return null;
  return (
    <p className="text-xs text-mute">
      This broker's paperwork needed manual correction {h.manualCount} of the last {h.consideredCount} time
      {h.consideredCount === 1 ? '' : 's'}.
    </p>
  );
}
