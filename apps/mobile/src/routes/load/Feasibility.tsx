/**
 * HaulQ Routes, 3a: can this truck run this load? Feasible or not, with the
 * deciding constraint named. Web's `CheckFeasibility` on a phone.
 *
 * Hours of service aren't checked (`hoursChecked` is always false), and that
 * is said every time, not just when something else goes wrong.
 * `not_configured` is a plain note, not an error, because it is a real
 * deployment state rather than a failure.
 */

import { useMutation } from '@tanstack/react-query';
import type { LoadFeasibilityResponse } from '@haulq/contracts';
import { useTrucks, type Load } from '@haulq/client';
import { useState } from 'react';
import { ApiRequestError, request } from '../../lib/api.ts';
import { ErrorNote, Field, Note, Pill } from '../../components/ui.tsx';
import { Section, when } from './shared.tsx';

export function FeasibilitySection({ load }: { load: Load }) {
  const trucks = useTrucks();
  const [truckId, setTruckId] = useState(load.truckId ?? '');

  const check = useMutation({
    mutationFn: () =>
      request<LoadFeasibilityResponse>(`/v1/loads/${load.id}/feasibility`, {
        method: 'POST',
        body: truckId ? { truckId } : {},
      }),
  });

  const notConfigured = check.error instanceof ApiRequestError && check.error.code === 'not_configured';
  const verdict = check.data;

  return (
    <Section
      title="Can this truck run it?"
      summary={verdict && <Pill tone={verdict.feasible ? 'ok' : 'warn'}>{verdict.feasible ? 'Feasible' : 'Infeasible'}</Pill>}
    >
      <p className="text-sm text-slate">Checks the route against the truck's size and this load's appointment windows.</p>
      <Field label="Truck to check">
        <select className="hq-input" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
          <option value="">The load's assigned truck</option>
          {(trucks.data?.items ?? []).filter((t) => t.active || t.id === load.truckId).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      <button type="button" className="hq-btn hq-btn-brand" disabled={check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? 'Checking…' : 'Check'}
      </button>

      {notConfigured ? <Note>Routing isn't connected on this deployment yet.</Note> : <ErrorNote error={check.error} />}

      {verdict && (
        <div className="space-y-1">
          <Pill tone={verdict.feasible ? 'ok' : 'warn'}>{verdict.feasible ? 'Feasible' : 'Infeasible'}</Pill>
          {verdict.decidingConstraint && <p className="text-sm text-warn">{verdict.decidingConstraint.message}</p>}
          <p className="text-sm text-slate">
            <span className="num">{Math.round(verdict.routeMiles).toLocaleString()}</span> mi · arrives{' '}
            {when(verdict.estimatedArrivalAt)}
          </p>
          <p className="text-xs text-mute">Hours of service not checked yet.</p>
        </div>
      )}
    </Section>
  );
}
