/**
 * What a load made, and where it is. Readable by every office role, including
 * accountants, the same as web's `LoadMarginDetail` and `TrackingPanel`.
 */

import {
  formatMinutes,
  LOAD_STATUS_TONE,
  prettyStatus,
  relativeAge,
  useLoadMargin,
  useLoadTracking,
  type TrackingStopView,
} from '@haulq/client';
import type { ReactNode } from 'react';
import { Card, Money, Pill } from '../../components/ui.tsx';
import { when } from './shared.tsx';

const INVOICE_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = { draft: 'neutral', sent: 'warn', paid: 'ok', void: 'neutral' };

const perMile = (cents: number | null) => (cents !== null ? `$${(cents / 100).toFixed(2)}` : null);

/**
 * `basis` is said plainly: an estimate that looks like a reconciled figure is
 * how a carrier learns to distrust the number.
 */
export function MarginCard({ loadId }: { loadId: string }) {
  const margin = useLoadMargin(loadId);
  if (!margin.data) return null;
  const m = margin.data;

  return (
    <Card title="What it made">
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Revenue" note={m.basis === 'actual' ? 'reconciled' : 'estimate'}>
          {m.revenueCents !== null ? <Money cents={m.revenueCents} /> : '—'}
        </Stat>
        <Stat label="Invoice">
          {m.invoiceStatus ? (
            <span className="flex flex-wrap items-center gap-1.5 font-sans">
              <Pill tone={INVOICE_TONE[m.invoiceStatus] ?? 'neutral'}>{m.invoiceStatus}</Pill>
              {m.invoiceTotalCents !== null && (
                <span className="text-sm">
                  <Money cents={m.invoiceTotalCents} />
                </span>
              )}
            </span>
          ) : (
            <span className="font-sans text-sm text-mute">not invoiced</span>
          )}
        </Stat>
        <Stat label="Per total mile">
          {perMile(m.revenuePerTotalMileCents) ?? <span className="font-sans text-sm text-mute">no deadhead recorded</span>}
        </Stat>
        <Stat label="Per loaded mile">{perMile(m.revenuePerLoadedMileCents) ?? '—'}</Stat>
      </div>
    </Card>
  );
}

function Stat({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div>
      <p className="field-label">{label}</p>
      <div className="num mt-1 text-lg">{children}</div>
      {note && <p className="text-xs text-mute">{note}</p>}
    </div>
  );
}

/**
 * Driver-reported progress. Carries the truck's precise coordinates, which
 * the broker's tracking page deliberately never shows.
 */
export function TrackingCard({ loadId }: { loadId: string }) {
  const tracking = useLoadTracking(loadId);
  if (!tracking.data) return null;
  const t = tracking.data;

  return (
    <Card title="Progress">
      <div className="space-y-1 border-b border-line pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{t.truck?.label ?? 'No truck assigned'}</span>
          <Pill tone={LOAD_STATUS_TONE[t.status] ?? 'neutral'}>{prettyStatus(t.status)}</Pill>
        </div>
        {t.truck &&
          (t.truck.currentCity ? (
            <p className="text-sm text-slate">
              {t.truck.currentCity}, {t.truck.currentState}
              {t.truck.positionAt && <span className="text-mute"> · {relativeAge(t.truck.positionAt)}</span>}
            </p>
          ) : (
            <p className="text-sm text-mute">No position reported yet.</p>
          ))}
        {t.eta && (
          <p className="text-sm text-slate">
            ETA stop {t.eta.stopSeq}: <span className="num font-medium text-ink">{when(t.eta.arrivalAt)}</span>
          </p>
        )}
      </div>

      {t.stops.length === 0 ? (
        <p className="pt-3 text-sm text-mute">No stops on this load.</p>
      ) : (
        <ol>
          {t.stops.map((stop) => (
            <TrackingStop key={stop.seq} stop={stop} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function TrackingStop({ stop }: { stop: TrackingStopView }) {
  const checkpoints = [
    { label: 'Arrived', at: stop.arrivedAt },
    { label: 'Loading started', at: stop.loadingStartedAt },
    { label: 'Loading ended', at: stop.loadingEndedAt },
    { label: 'Departed', at: stop.departedAt },
  ];
  const reached = checkpoints.some((c) => c.at);

  return (
    <li className="border-b border-line py-3 last:border-b-0 last:pb-0">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="field-label text-brand">{stop.type === 'pickup' ? 'Pickup' : 'Delivery'}</p>
          <p>
            {stop.facilityName ? `${stop.facilityName}, ` : ''}
            {stop.city}, {stop.state}
          </p>
          {stop.windowStart && <p className="text-xs text-mute">Appointment {when(stop.windowStart)}</p>}
        </div>
        <DetentionBadge stop={stop} />
      </div>
      {reached ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
          {checkpoints.map((c) => (
            <div key={c.label}>
              <dt className="field-label">{c.label}</dt>
              <dd className="text-sm">{c.at ? when(c.at) : '—'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 text-sm text-mute">Not there yet.</p>
      )}
    </li>
  );
}

function DetentionBadge({ stop }: { stop: TrackingStopView }) {
  if (stop.detentionMinutes === null) return null;
  if (stop.detentionMinutes === 0) return stop.stillOnSite ? <Pill>on time so far</Pill> : null;
  return (
    <Pill tone="warn">
      {stop.stillOnSite ? 'detention' : 'was in detention'} +{formatMinutes(stop.detentionMinutes)}
    </Pill>
  );
}
