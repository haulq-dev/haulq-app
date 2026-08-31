/**
 * Loads.
 *
 * The screen a dispatcher leaves open. Two things shape it:
 *
 * **Rate per total mile is the headline, not rate per loaded mile.** A load at
 * $400 for 127 loaded miles reads as $3.15/mi and looks excellent; add the 176
 * miles of deadhead to reach it and it is $1.32/mi, which is mediocre. Showing
 * the flattering number is how a carrier learns the tool is wrong, so the
 * total-mile figure is the large one and the loaded-mile figure sits beside it
 * in grey.
 *
 * **Transitions that cannot happen are not offered.** `canTransition` mirrors
 * the database trigger, so the menu only contains moves that will succeed. The
 * database is still the enforcement — if the two disagree the trigger wins and
 * the error surfaces — but a dropdown of options that mostly fail is a screen
 * nobody trusts.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  canTransition,
  LOAD_STATUSES,
  nextStatuses,
  type LoadFeasibilityResponse,
  type LoadStatus,
} from '@haulq/contracts';
import { ApiRequestError, request, type Driver, type Truck } from '../lib/api.ts';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, Label, LoadMore, Money, Num, Pill } from '../components/ui.tsx';

interface Stop {
  id: string;
  seq: number;
  type: 'pickup' | 'delivery';
  city: string;
  state: string;
  facilityName: string | null;
  lat: number | null;
  lng: number | null;
  windowStart: string | null;
  windowEnd: string | null;
}

interface Load {
  id: string;
  reference: number;
  status: LoadStatus;
  source: string;
  brokerId: string | null;
  brokerName: string | null;
  /** Null means the broker has no override — the tracking page falls back to a two-hour default. */
  brokerDetentionFreeMinutes: number | null;
  brokerLoadNumber: string | null;
  equipment: string;
  commodity: string | null;
  weightLbs: number | null;
  rateAmount: number | null;
  rateCurrency: string | null;
  rateIsLinehaul: boolean;
  expectedDeadheadMiles: number | null;
  expectedLoadedMiles: number | null;
  truckId: string | null;
  truckLabel: string | null;
  driverId: string | null;
  driverName: string | null;
  cancelledReason: string | null;
  stops: Stop[];
}

interface LoadsResponse {
  items: Load[];
  counts: Record<string, number>;
  nextCursor: string | null;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  delivered: 'ok',
  invoiced: 'ok',
  paid: 'ok',
  cancelled: 'warn',
};

const pretty = (s: string) => s.replace(/_/g, ' ');

/**
 * The two rate-per-mile figures.
 *
 * Returns null when deadhead is unknown rather than assuming zero. Assuming
 * zero produces the flattering number by default, which is the exact failure
 * this screen exists to avoid.
 */
function perMile(load: Load): { total: number; loaded: number } | null {
  if (!load.rateAmount || !load.expectedLoadedMiles) return null;
  const loaded = load.rateAmount / load.expectedLoadedMiles;
  if (load.expectedDeadheadMiles === null) return null;
  const totalMiles = load.expectedLoadedMiles + load.expectedDeadheadMiles;
  return { total: load.rateAmount / totalMiles, loaded };
}

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function RatePerMile({ load }: { load: Load }) {
  const rates = perMile(load);
  if (!rates) {
    return (
      <span className="text-xs text-mute">
        {load.expectedLoadedMiles === null ? 'no miles' : 'no deadhead recorded'}
      </span>
    );
  }
  const thin = rates.total < 150; // under $1.50/mi, roughly
  return (
    <span className="block">
      <span className={`num text-base ${thin ? 'text-warn' : 'text-ink'}`}>
        {money(rates.total)}
      </span>
      <span className="field-label ml-1 text-mute">/total mi</span>
      <span className="num ml-2 text-xs text-mute">
        {money(rates.loaded)} loaded
      </span>
    </span>
  );
}

function StatusControl({ load }: { load: Load }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<LoadStatus | null>(null);

  const move = useMutation({
    mutationFn: (next: { status: LoadStatus; reason?: string }) =>
      request(`/v1/loads/${load.id}/status`, { method: 'PATCH', body: next }),
    onSuccess: async () => {
      setPending(null);
      setReason('');
      await queryClient.invalidateQueries();
    },
  });

  const options = nextStatuses(load.status);
  if (options.length === 0) {
    return <span className="field-label text-mute">no further moves</span>;
  }

  // Cancelling needs a reason, so it gets a second step rather than firing on
  // change and failing.
  if (pending === 'cancelled') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="hq-input w-auto py-1 text-sm"
          placeholder="Why is this cancelled?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="hq-btn hq-btn-ghost text-bad"
          disabled={!reason.trim() || move.isPending}
          onClick={() => move.mutate({ status: 'cancelled', reason })}
        >
          Cancel load
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={() => setPending(null)}>
          Back
        </button>
        <ErrorNote error={move.error} />
      </div>
    );
  }

  return (
    <>
      <select
        className="hq-input w-auto py-1 text-sm"
        value=""
        disabled={move.isPending}
        onChange={(e) => {
          const next = e.target.value as LoadStatus;
          if (!next) return;
          if (next === 'cancelled') setPending('cancelled');
          else move.mutate({ status: next });
        }}
      >
        <option value="">Move to…</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {pretty(s)}
          </option>
        ))}
      </select>
      <ErrorNote error={move.error} />
    </>
  );
}

function AssignControl({ load, trucks }: { load: Load; trucks: Truck[] }) {
  const queryClient = useQueryClient();
  const assign = useMutation({
    mutationFn: (truckId: string | null) =>
      request(`/v1/loads/${load.id}/assignment`, { method: 'PATCH', body: { truckId } }),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  return (
    <>
      <select
        className="hq-input w-auto py-1 text-sm"
        value={load.truckId ?? ''}
        disabled={assign.isPending}
        onChange={(e) => assign.mutate(e.target.value || null)}
      >
        <option value="">No truck</option>
        {trucks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <ErrorNote error={assign.error} />
    </>
  );
}

function AddLoad({ trucks, onDone }: { trucks: Truck[]; onDone: () => void }) {
  const [brokerName, setBroker] = useState('');
  const [rate, setRate] = useState('');
  const [loadedMiles, setLoadedMiles] = useState('');
  const [deadheadMiles, setDeadhead] = useState('');
  const [commodity, setCommodity] = useState('');
  const [weightLbs, setWeight] = useState('');
  const [status, setStatus] = useState<LoadStatus>('prospect');
  const [truckId, setTruckId] = useState('');
  const [pickup, setPickup] = useState({ city: '', state: '', lat: '', lng: '' });
  const [delivery, setDelivery] = useState({ city: '', state: '', lat: '', lng: '', windowEnd: '' });

  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      request<Load>('/v1/loads', {
        body: {
          source: 'manual',
          status,
          ...(brokerName ? { brokerName } : {}),
          ...(commodity ? { commodity } : {}),
          ...(weightLbs ? { weightLbs: Number(weightLbs) } : {}),
          // Dollars in the box, minor units on the wire. Build plan section 5 —
          // never floats near an invoice.
          ...(rate ? { rate: { amount: Math.round(Number(rate) * 100), currency: 'USD' } } : {}),
          ...(loadedMiles ? { expectedLoadedMiles: Number(loadedMiles) } : {}),
          ...(deadheadMiles ? { expectedDeadheadMiles: Number(deadheadMiles) } : {}),
          ...(truckId ? { truckId } : {}),
          stops: [
            {
              type: 'pickup',
              city: pickup.city,
              state: pickup.state,
              ...(pickup.lat && pickup.lng ? { lat: Number(pickup.lat), lng: Number(pickup.lng) } : {}),
            },
            {
              type: 'delivery',
              city: delivery.city,
              state: delivery.state,
              ...(delivery.lat && delivery.lng
                ? { lat: Number(delivery.lat), lng: Number(delivery.lng) }
                : {}),
              // `datetime-local` has no timezone of its own — the browser gives a
              // bare "2026-09-01T18:00" in the viewer's local time, and `Date`
              // parses that as local time too, so this is correct without a
              // manual offset.
              ...(delivery.windowEnd ? { windowEnd: new Date(delivery.windowEnd).toISOString() } : {}),
            },
          ],
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDone();
    },
  });

  const ready =
    pickup.city && pickup.state.length === 2 && delivery.city && delivery.state.length === 2;

  return (
    <Card title="Add a load">
      <div className="grid gap-5 sm:grid-cols-4">
        <Field label="Pickup city">
          <input className="hq-input" value={pickup.city} onChange={(e) => setPickup({ ...pickup, city: e.target.value })} />
        </Field>
        <Field label="State" hint="Two letters.">
          <input className="hq-input" maxLength={2} value={pickup.state} onChange={(e) => setPickup({ ...pickup, state: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Delivery city">
          <input className="hq-input" value={delivery.city} onChange={(e) => setDelivery({ ...delivery, city: e.target.value })} />
        </Field>
        <Field label="State">
          <input className="hq-input" maxLength={2} value={delivery.state} onChange={(e) => setDelivery({ ...delivery, state: e.target.value.toUpperCase() })} />
        </Field>
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-4">
        <Field label="Pickup coordinates" hint="Optional — lets HaulQ Routes check feasibility on this load.">
          <div className="flex gap-2">
            <input className="hq-input" data-numeric="true" inputMode="decimal" placeholder="lat" value={pickup.lat} onChange={(e) => setPickup({ ...pickup, lat: e.target.value })} />
            <input className="hq-input" data-numeric="true" inputMode="decimal" placeholder="lng" value={pickup.lng} onChange={(e) => setPickup({ ...pickup, lng: e.target.value })} />
          </div>
        </Field>
        <Field label="Delivery coordinates" hint="Both stops need one for a feasibility check to run at all.">
          <div className="flex gap-2">
            <input className="hq-input" data-numeric="true" inputMode="decimal" placeholder="lat" value={delivery.lat} onChange={(e) => setDelivery({ ...delivery, lat: e.target.value })} />
            <input className="hq-input" data-numeric="true" inputMode="decimal" placeholder="lng" value={delivery.lng} onChange={(e) => setDelivery({ ...delivery, lng: e.target.value })} />
          </div>
        </Field>
        <Field label="Delivery appointment ends" hint="A route arriving after this is infeasible, named as such.">
          <input
            className="hq-input"
            type="datetime-local"
            value={delivery.windowEnd}
            onChange={(e) => setDelivery({ ...delivery, windowEnd: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-4">
        <Field label="Rate ($)">
          <input className="hq-input" data-numeric="true" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="Loaded miles">
          <input className="hq-input" data-numeric="true" inputMode="numeric" value={loadedMiles} onChange={(e) => setLoadedMiles(e.target.value)} />
        </Field>
        <Field label="Deadhead miles" hint="Miles to reach the pickup. This is the number that decides whether the load is good.">
          <input className="hq-input" data-numeric="true" inputMode="numeric" value={deadheadMiles} onChange={(e) => setDeadhead(e.target.value)} />
        </Field>
        <Field label="Broker">
          <input className="hq-input" value={brokerName} onChange={(e) => setBroker(e.target.value)} />
        </Field>
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-4">
        <Field label="Commodity">
          <input className="hq-input" value={commodity} onChange={(e) => setCommodity(e.target.value)} />
        </Field>
        <Field label="Weight (lbs)">
          <input className="hq-input" data-numeric="true" inputMode="numeric" value={weightLbs} onChange={(e) => setWeight(e.target.value)} />
        </Field>
        <Field label="Status">
          <select className="hq-input" value={status} onChange={(e) => setStatus(e.target.value as LoadStatus)}>
            {LOAD_STATUSES.filter((s) => s !== 'cancelled' && canTransition('prospect', s).allowed).map((s) => (
              <option key={s} value={s}>{pretty(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="Truck" hint="Required from dispatched onward.">
          <select className="hq-input" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
            <option value="">No truck yet</option>
            {trucks.map((t) => (<option key={t.id} value={t.id}>{t.label}</option>))}
          </select>
        </Field>
      </div>

      <div className="mt-6 flex gap-3">
        <button className="hq-btn hq-btn-brand" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Adding…' : 'Add load'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={onDone}>Cancel</button>
      </div>

      <ErrorNote error={create.error} />
    </Card>
  );
}

interface LoadMargin {
  reference: number;
  revenueCents: number | null;
  loadedMiles: number | null;
  deadheadMiles: number | null;
  revenuePerTotalMileCents: number | null;
  revenuePerLoadedMileCents: number | null;
  basis: 'actual' | 'expected';
  invoiceStatus: string | null;
  invoiceTotalCents: number | null;
}

const INVOICE_STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  draft: 'neutral',
  sent: 'warn',
  paid: 'ok',
  void: 'neutral',
};

/**
 * What one load actually made — PHASE_1_PLAN.md section 4's per-load gap.
 * `basis` matters here more than in the table's own per-mile column: the
 * table already shows the estimate everywhere, so this is where "is that
 * number real yet" gets said plainly.
 */
function LoadMarginDetail({ loadId }: { loadId: string }) {
  const margin = useQuery({
    queryKey: ['load-margin', loadId],
    queryFn: () => request<LoadMargin>(`/v1/loads/${loadId}/margin`),
  });

  if (!margin.data) return null;
  const m = margin.data;

  return (
    <Card title={`Load ${m.reference} — what it made`}>
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <Label>Revenue</Label>
          <div className="num mt-1 text-lg">
            {m.revenueCents !== null ? <Money cents={m.revenueCents} /> : '—'}
          </div>
          <span className="field-label text-mute">
            {m.basis === 'actual' ? 'reconciled' : 'estimated, not yet reconciled'}
          </span>
        </div>
        <div>
          <Label>Per total mile</Label>
          <div className="num mt-1 text-lg">
            {m.revenuePerTotalMileCents !== null
              ? `$${(m.revenuePerTotalMileCents / 100).toFixed(2)}`
              : 'no deadhead recorded'}
          </div>
        </div>
        <div>
          <Label>Per loaded mile</Label>
          <div className="num mt-1 text-lg">
            {m.revenuePerLoadedMileCents !== null
              ? `$${(m.revenuePerLoadedMileCents / 100).toFixed(2)}`
              : '—'}
          </div>
        </div>
        <div>
          <Label>Invoice</Label>
          <div className="mt-1">
            {m.invoiceStatus ? (
              <>
                <Pill tone={INVOICE_STATUS_TONE[m.invoiceStatus] ?? 'neutral'}>
                  {m.invoiceStatus}
                </Pill>
                {m.invoiceTotalCents !== null && (
                  <span className="num ml-2 text-sm text-slate">
                    <Money cents={m.invoiceTotalCents} />
                  </span>
                )}
              </>
            ) : (
              <span className="text-sm text-mute">not invoiced yet</span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * A broker's tracking link — PHASE_2_PLAN.md section 4's exit gate, the
 * carrier-facing half. The driver check-in link is deliberately not offered
 * here: which surface a driver reaches it through (a web page, a native
 * app) is an open decision in the plan, and a "send to driver" button that
 * points at a page nobody has built yet is worse than no button.
 *
 * The token is shown once, matching `inviteMember`'s own contract — it is
 * never retrievable again, only its hash is stored.
 */
function TrackingLink({ loadId, reference }: { loadId: string; reference: number }) {
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const issue = useMutation({
    mutationFn: () =>
      request<{ token: string }>(`/v1/loads/${loadId}/visibility-links`, { method: 'POST' }),
    onSuccess: (res) => {
      setIssuedUrl(`${window.location.origin}/track/${res.token}`);
      setCopied(false);
    },
  });

  const revoke = useMutation({
    mutationFn: () => request(`/v1/loads/${loadId}/visibility-links`, { method: 'DELETE' }),
    onSuccess: () => setIssuedUrl(null),
  });

  const copy = async () => {
    if (!issuedUrl) return;
    await navigator.clipboard.writeText(issuedUrl);
    setCopied(true);
  };

  return (
    <Card title={`Load ${reference} — broker tracking link`}>
      {issuedUrl ? (
        <div className="space-y-3">
          <p className="text-sm text-slate">
            Send this to the broker. It works with no HaulQ account, and is
            shown only once — copy it now.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all border border-line bg-wash px-3 py-2 text-xs">
              {issuedUrl}
            </code>
            <button className="hq-btn hq-btn-ghost" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            className="hq-btn hq-btn-ghost text-bad"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {revoke.isPending ? 'Revoking…' : 'Revoke this link'}
          </button>
        </div>
      ) : (
        <button
          className="hq-btn hq-btn-brand"
          disabled={issue.isPending}
          onClick={() => issue.mutate()}
        >
          {issue.isPending ? 'Creating…' : 'Create tracking link'}
        </button>
      )}
      <ErrorNote error={issue.error ?? revoke.error} />
    </Card>
  );
}

/**
 * The code a driver types into the HaulQ Driver app.
 *
 * Deliberately not a URL like `TrackingLink` builds — the driver app has no
 * web-hosted origin to point one at (it ships as a native iOS/Android build,
 * not a page on this deployment), so constructing `${origin}/checkin/...`
 * here would be a link that goes nowhere. The driver app's own paste box
 * already accepts a bare code for exactly this reason.
 */

/**
 * Remembers a just-issued code across a reload of this page, in this
 * browser only — never sent to or stored by the server, which still only
 * ever keeps the hash. Reloading a page mid-task is an easy way to lose a
 * code nobody copied down yet, and the actual security property "the
 * server cannot show it to you again" is unaffected either way: this is
 * the same browser tab remembering what it already had on screen a moment
 * ago, not a new way to retrieve it. Keeps the assigned driver alongside
 * the code so a reload does not lose track of who it was for either.
 */
const checkinCodeStorageKey = (loadId: string) => `haulq.checkinCode.${loadId}`;

interface IssuedCheckin {
  token: string;
  driverId: string | null;
}

function storedCheckin(loadId: string): IssuedCheckin | null {
  try {
    const raw = localStorage.getItem(checkinCodeStorageKey(loadId));
    return raw ? (JSON.parse(raw) as IssuedCheckin) : null;
  } catch {
    return null;
  }
}

function CheckinLink({
  loadId,
  reference,
  drivers,
  currentDriverId,
}: {
  loadId: string;
  reference: number;
  drivers: Driver[];
  currentDriverId: string | null;
}) {
  const [issued, setIssued] = useState<IssuedCheckin | null>(() => storedCheckin(loadId));
  // Defaults to whoever the load is already assigned to — the common case
  // is issuing a code for the driver already running it, not a stranger.
  const [selectedDriverId, setSelectedDriverId] = useState(currentDriverId ?? '');
  const [copied, setCopied] = useState(false);

  const issue = useMutation({
    mutationFn: () =>
      request<{ token: string; link: { driverId: string | null } }>(
        `/v1/loads/${loadId}/checkin-links`,
        { method: 'POST', body: selectedDriverId ? { driverId: selectedDriverId } : {} },
      ),
    onSuccess: (res) => {
      const record: IssuedCheckin = { token: res.token, driverId: res.link.driverId };
      try {
        localStorage.setItem(checkinCodeStorageKey(loadId), JSON.stringify(record));
      } catch {
        // Private browsing or storage disabled — the code still works, it
        // just will not survive a reload of this page.
      }
      setIssued(record);
      setCopied(false);
    },
  });

  const revoke = useMutation({
    mutationFn: () => request(`/v1/loads/${loadId}/checkin-links`, { method: 'DELETE' }),
    onSuccess: () => {
      try {
        localStorage.removeItem(checkinCodeStorageKey(loadId));
      } catch {
        // Nothing to clean up if it was never stored.
      }
      setIssued(null);
    },
  });

  const copy = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.token);
    setCopied(true);
  };

  const assignedDriver = issued?.driverId ? drivers.find((d) => d.id === issued.driverId) : undefined;

  return (
    <Card title={`Load ${reference} — driver check-in code`}>
      {issued ? (
        <div className="space-y-3">
          {assignedDriver && (
            <p className="text-sm text-slate">
              For <span className="font-medium">{assignedDriver.fullName}</span>
              {assignedDriver.phone && <> — {assignedDriver.phone}</>}
            </p>
          )}
          <p className="text-sm text-slate">
            Text or read this to the driver. They open the HaulQ Driver app
            and paste it in — shown only once, copy it now.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all border border-line bg-wash px-3 py-2 text-xs">
              {issued.token}
            </code>
            <button className="hq-btn hq-btn-ghost" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            className="hq-btn hq-btn-ghost text-bad"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {revoke.isPending ? 'Revoking…' : 'Revoke this code'}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Driver" hint="Optional — leave unassigned if you don't know who yet.">
            <select
              className="hq-input"
              value={selectedDriverId}
              onChange={(e) => setSelectedDriverId(e.target.value)}
            >
              <option value="">Not assigned yet</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName}
                </option>
              ))}
            </select>
          </Field>
          <button
            className="hq-btn hq-btn-brand"
            disabled={issue.isPending}
            onClick={() => issue.mutate()}
          >
            {issue.isPending ? 'Creating…' : 'Create a check-in code'}
          </button>
        </div>
      )}
      <ErrorNote error={issue.error ?? revoke.error} />
    </Card>
  );
}

/** `<input type="datetime-local">` wants local time with no timezone marker, same conversion `AddLoad`'s delivery window already does. */
function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface StopEditValues {
  lat: string;
  lng: string;
  windowStart: string;
  windowEnd: string;
}

/**
 * `PATCH /v1/loads/:id/stops/:stopId` — `PHASE_3A_ROUTES_WALKTHROUGH.md`'s
 * own "not covered" list named this gap: the endpoint existed with no
 * screen calling it, so fixing a typo'd coordinate or a wrong appointment
 * time on a load that already exists meant a raw API call. One row per
 * stop rather than one form for the whole load, since `updateLoadStop`
 * itself is per-stop and a load's stops rarely need editing together.
 *
 * Coordinates are kept as a pair on save — both filled or both cleared —
 * because a lat with no lng (or the reverse) is not a location, it is half
 * of one, and `routes/feasibility.ts`'s `missing_coordinates` check would
 * treat it as absent anyway.
 */
function EditLoadStops({ load }: { load: Load }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, StopEditValues>>(() =>
    Object.fromEntries(
      load.stops.map((s) => [
        s.id,
        {
          lat: s.lat !== null ? String(s.lat) : '',
          lng: s.lng !== null ? String(s.lng) : '',
          windowStart: toDatetimeLocal(s.windowStart),
          windowEnd: toDatetimeLocal(s.windowEnd),
        },
      ]),
    ),
  );

  const save = useMutation({
    mutationFn: (stopId: string) => {
      const v = values[stopId]!;
      return request(`/v1/loads/${load.id}/stops/${stopId}`, {
        method: 'PATCH',
        body: {
          lat: v.lat && v.lng ? Number(v.lat) : null,
          lng: v.lat && v.lng ? Number(v.lng) : null,
          windowStart: v.windowStart ? new Date(v.windowStart).toISOString() : null,
          windowEnd: v.windowEnd ? new Date(v.windowEnd).toISOString() : null,
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });

  const setField = (stopId: string, field: keyof StopEditValues, value: string) =>
    setValues((prev) => ({ ...prev, [stopId]: { ...prev[stopId]!, [field]: value } }));

  const sorted = [...load.stops].sort((a, b) => a.seq - b.seq);

  return (
    <Card title={`Load ${load.reference} — stops`}>
      <p className="mb-3 text-sm text-slate">
        Coordinates and the appointment window are what a feasibility check
        reads. Both coordinate fields are needed together, or leave both
        blank.
      </p>
      <div className="space-y-4">
        {sorted.map((stop) => {
          const v = values[stop.id]!;
          const mismatched = Boolean(v.lat) !== Boolean(v.lng);
          return (
            <div key={stop.id} className="border border-line p-3">
              <div className="mb-2 text-sm font-medium">
                Stop {stop.seq} — {stop.type} — {stop.city}, {stop.state}
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Lat">
                  <input
                    className="hq-input py-1 text-sm"
                    data-numeric="true"
                    inputMode="decimal"
                    value={v.lat}
                    onChange={(e) => setField(stop.id, 'lat', e.target.value)}
                  />
                </Field>
                <Field label="Lng">
                  <input
                    className="hq-input py-1 text-sm"
                    data-numeric="true"
                    inputMode="decimal"
                    value={v.lng}
                    onChange={(e) => setField(stop.id, 'lng', e.target.value)}
                  />
                </Field>
                <Field label="Window opens">
                  <input
                    className="hq-input py-1 text-sm"
                    type="datetime-local"
                    value={v.windowStart}
                    onChange={(e) => setField(stop.id, 'windowStart', e.target.value)}
                  />
                </Field>
                <Field label="Window closes">
                  <input
                    className="hq-input py-1 text-sm"
                    type="datetime-local"
                    value={v.windowEnd}
                    onChange={(e) => setField(stop.id, 'windowEnd', e.target.value)}
                  />
                </Field>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="hq-btn hq-btn-ghost px-3 py-1 text-xs"
                  disabled={mismatched || save.isPending}
                  onClick={() => save.mutate(stop.id)}
                >
                  {save.isPending ? 'Saving…' : 'Save this stop'}
                </button>
                {mismatched && (
                  <span className="text-xs text-warn">Fill both lat and lng, or clear both.</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <ErrorNote error={save.error} />
    </Card>
  );
}

/**
 * HaulQ Routes, 3a — PHASE_3_PLAN.md section 4's single-load exit gate: given
 * one truck and one load, feasible or infeasible, with the deciding
 * constraint named when it is not. `hoursChecked` is always false on the
 * response — section 7 has not decided whether Phase 3 pulls HOS data yet —
 * so that caveat is shown every time, not just when something else went
 * wrong, the same "say what you don't know" discipline `VerifyBroker` above
 * already applies to an unchecked broker.
 *
 * `not_configured` is not an edge case here the way it is for Motive or
 * Azure — it is this deployment's actual current state, HERE not being
 * signed up for yet (`PHASE_3_PLAN.md` section 7a's own note) — so it gets a
 * plain, expected-looking message rather than `ErrorNote`'s alert styling.
 */
function CheckFeasibility({ load, trucks }: { load: Load; trucks: Truck[] }) {
  const [truckId, setTruckId] = useState(load.truckId ?? '');

  const check = useMutation({
    mutationFn: () =>
      request<LoadFeasibilityResponse>(`/v1/loads/${load.id}/feasibility`, {
        method: 'POST',
        body: truckId ? { truckId } : {},
      }),
  });

  const notConfigured =
    check.error instanceof ApiRequestError && check.error.code === 'not_configured';

  return (
    <Card title={`Load ${load.reference} — feasibility`}>
      <p className="mb-3 text-sm text-slate">
        Checks the route against the truck's dimensions and this load's
        appointment windows. Hours of service are not checked yet.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className="hq-input w-auto py-1 text-sm"
          value={truckId}
          onChange={(e) => setTruckId(e.target.value)}
        >
          <option value="">Use the load's assigned truck</option>
          {trucks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          className="hq-btn hq-btn-brand"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? 'Checking…' : 'Check feasibility'}
        </button>
      </div>

      {notConfigured ? (
        <p className="border-l-2 border-line bg-wash px-3 py-2 text-sm text-mute">
          Routing is not connected on this deployment yet.
        </p>
      ) : (
        <ErrorNote error={check.error} />
      )}

      {check.data && (
        <div className="space-y-2">
          <Pill tone={check.data.feasible ? 'ok' : 'warn'}>
            {check.data.feasible ? 'Feasible' : 'Infeasible'}
          </Pill>
          {check.data.decidingConstraint && (
            <p className="text-sm text-warn">{check.data.decidingConstraint.message}</p>
          )}
          <p className="text-sm text-slate">
            <Num value={Math.round(check.data.routeMiles)} /> mi · arrives{' '}
            {new Date(check.data.estimatedArrivalAt).toLocaleString()}
          </p>
          <p className="text-xs text-mute">Hours of service not checked yet.</p>
        </div>
      )}
    </Card>
  );
}

/**
 * The per-broker detention free time — PHASE_2_PLAN.md section 7's
 * threshold question, landed on per-broker rather than a carrier-wide
 * default. Edited here, on the load a carrier is already looking at,
 * rather than a separate broker-management screen that does not exist yet
 * — the setting applies to every load with this broker, not just this one,
 * which the copy says plainly so it is not mistaken for a per-load override.
 */
function DetentionThreshold({
  brokerId,
  brokerName,
  freeMinutes,
}: {
  brokerId: string;
  brokerName: string;
  freeMinutes: number | null;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(freeMinutes !== null ? String(freeMinutes) : '');

  const save = useMutation({
    mutationFn: (minutes: number | null) =>
      request(`/v1/brokers/${brokerId}/detention-threshold`, {
        method: 'PATCH',
        body: { freeMinutes: minutes },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loads'] });
    },
  });

  return (
    <Card title={`${brokerName} — detention free time`}>
      <p className="mb-3 text-sm text-slate">
        Applies to every load with this broker, not just this one. Leave
        blank to use the two-hour default.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="hq-input w-32"
          data-numeric="true"
          inputMode="numeric"
          placeholder="120"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <span className="text-sm text-mute">minutes</span>
        <button
          className="hq-btn hq-btn-brand"
          disabled={save.isPending}
          onClick={() => save.mutate(value.trim() ? Number(value) : null)}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <ErrorNote error={save.error} />
    </Card>
  );
}

interface BrokerVerificationResponse {
  mcNumber: string | null;
  usdotNumber: string | null;
  verification: {
    source: string;
    operatingStatus: string | null;
    checkedAt: string;
  } | null;
}

/**
 * Check a broker against FMCSA — PHASE_0B_PLAN.md's 0b-i, on the load a
 * carrier is already looking at, same reasoning `DetentionThreshold` above
 * already gives for not having a separate broker-management screen. Reads
 * and writes the docket number here too, since `resolveBroker` never learns
 * one from a load and this is the one place a carrier would think to put it.
 */
function VerifyBroker({ brokerId, brokerName }: { brokerId: string; brokerName: string }) {
  const queryClient = useQueryClient();
  const [mcNumber, setMcNumber] = useState('');

  const info = useQuery({
    queryKey: ['broker-verification', brokerId],
    queryFn: () => request<BrokerVerificationResponse>(`/v1/brokers/${brokerId}/verification`),
  });

  const saveDocket = useMutation({
    mutationFn: () =>
      request(`/v1/brokers/${brokerId}/docket`, {
        method: 'PATCH',
        body: { mcNumber: mcNumber.trim() || null },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['broker-verification', brokerId] });
    },
  });

  const verify = useMutation({
    mutationFn: () => request(`/v1/brokers/${brokerId}/verify`, { method: 'POST' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['broker-verification', brokerId] });
    },
  });

  const onFile = info.data?.mcNumber ?? info.data?.usdotNumber ?? null;
  const status = info.data?.verification?.operatingStatus ?? null;

  return (
    <Card title={`${brokerName} — verify`}>
      <p className="mb-3 text-sm text-slate">
        Checks this broker's operating authority against FMCSA. Free, and
        never automatic — nothing here books or blocks a load on its own.
      </p>

      {onFile ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="num text-sm text-slate">
            {info.data?.mcNumber ? `MC ${info.data.mcNumber}` : `DOT ${info.data?.usdotNumber}`}
          </span>
          {status && (
            <Pill tone={status === 'Authorized' ? 'ok' : status === 'Not authorized' ? 'warn' : 'neutral'}>
              {status}
            </Pill>
          )}
          {!status && info.data?.verification === null && (
            <span className="text-xs text-mute">not checked yet</span>
          )}
          <button
            className="hq-btn hq-btn-brand"
            disabled={verify.isPending}
            onClick={() => verify.mutate()}
          >
            {verify.isPending ? 'Checking…' : status ? 'Check again' : 'Check now'}
          </button>
        </div>
      ) : (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            className="hq-input w-40"
            placeholder="MC 123456"
            value={mcNumber}
            onChange={(e) => setMcNumber(e.target.value)}
          />
          <button
            className="hq-btn hq-btn-brand"
            disabled={saveDocket.isPending || !mcNumber.trim()}
            onClick={() => saveDocket.mutate()}
          >
            {saveDocket.isPending ? 'Saving…' : 'Save'}
          </button>
          <span className="text-xs text-mute">Needed before this broker can be checked.</span>
        </div>
      )}

      {info.data?.verification?.checkedAt && (
        <p className="text-xs text-mute">
          Last checked {new Date(info.data.verification.checkedAt).toLocaleString()} via{' '}
          {info.data.verification.source}.
        </p>
      )}

      <ErrorNote error={saveDocket.error ?? verify.error} />
    </Card>
  );
}

export function LoadsScreen() {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<LoadStatus | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = useSession();
  const orgs = useOrgs();

  // The detail panels render below the whole load table, which for any real
  // number of loads sits well past the fold — clicking a load's reference
  // number changed real state but looked like nothing happened at all,
  // since nothing carried the page there. `behavior: 'smooth'` rather than
  // an instant jump, so the click reads as cause and effect.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedId) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedId]);

  const loads = useInfiniteQuery({
    queryKey: ['loads', filter],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      request<LoadsResponse>(
        `/v1/loads?${new URLSearchParams({
          ...(filter ? { status: filter } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const trucks = useQuery({
    queryKey: ['trucks'],
    queryFn: () => request<{ items: Truck[] }>('/v1/trucks'),
  });

  const drivers = useQuery({
    queryKey: ['drivers'],
    queryFn: () => request<{ items: Driver[] }>('/v1/drivers'),
  });

  const myRole = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  const canWrite = myRole === 'owner' || myRole === 'dispatcher';

  const items = loads.data?.pages.flatMap((p) => p.items) ?? [];
  // Every page carries the same org-wide counts — only the first page's is
  // needed, not a merge across pages.
  const counts = loads.data?.pages[0]?.counts ?? {};

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Loads</h1>
          <p className="mt-1 max-w-prose text-slate">
            Every load, and what each one actually pays once the empty miles to
            reach it are counted.
          </p>
        </div>
        {canWrite && !adding && (
          <button className="hq-btn hq-btn-primary" onClick={() => setAdding(true)}>
            Add a load
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          className={`field-label border px-3 py-2 ${filter === '' ? 'border-ink bg-wash text-ink' : 'border-line text-mute hover:text-ink'}`}
          onClick={() => setFilter('')}
        >
          All <Num value={Object.values(counts).reduce((a, b) => a + b, 0)} />
        </button>
        {LOAD_STATUSES.filter((s) => counts[s]).map((s) => (
          <button
            key={s}
            className={`field-label border px-3 py-2 ${filter === s ? 'border-ink bg-wash text-ink' : 'border-line text-mute hover:text-ink'}`}
            onClick={() => setFilter(s)}
          >
            {pretty(s)} <Num value={counts[s] ?? 0} />
          </button>
        ))}
      </div>

      {adding && (
        <AddLoad trucks={trucks.data?.items ?? []} onDone={() => setAdding(false)} />
      )}

      <Card>
        {loads.isError && <ErrorNote error={loads.error} />}
        {loads.data && items.length === 0 && (
          <Empty>
            {filter ? `Nothing at ${pretty(filter)}.` : 'No loads yet.'}
          </Empty>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="hq-table">
              <thead>
                <tr>
                  <th className="field-label">Load</th>
                  <th className="field-label">Lane</th>
                  <th className="field-label">Rate</th>
                  <th className="field-label">Per mile</th>
                  <th className="field-label">Status</th>
                  <th className="field-label">Truck</th>
                </tr>
              </thead>
              <tbody>
                {items.map((load) => {
                  const pickup = load.stops.find((s) => s.type === 'pickup');
                  const delivery = [...load.stops].reverse().find((s) => s.type === 'delivery');
                  return (
                    <tr key={load.id} className={selectedId === load.id ? 'bg-wash' : undefined}>
                      <td>
                        <button
                          className="num block text-left font-medium hover:underline"
                          onClick={() => setSelectedId(load.id)}
                        >
                          {load.reference}
                        </button>
                        <span className="block text-xs text-mute">
                          {load.brokerName ?? 'no broker'}
                        </span>
                      </td>
                      <td className="text-sm">
                        {pickup ? `${pickup.city}, ${pickup.state}` : '—'}
                        <span className="text-mute"> → </span>
                        {delivery ? `${delivery.city}, ${delivery.state}` : '—'}
                        {load.expectedLoadedMiles !== null && (
                          <span className="block text-xs text-mute">
                            <Num value={load.expectedLoadedMiles} /> loaded
                            {load.expectedDeadheadMiles !== null && (
                              <> · <Num value={load.expectedDeadheadMiles} /> deadhead</>
                            )}
                          </span>
                        )}
                      </td>
                      <td>
                        {load.rateAmount !== null ? (
                          <>
                            <Money cents={load.rateAmount} />
                            {load.rateIsLinehaul && (
                              <span className="block text-xs text-warn">linehaul only</span>
                            )}
                          </>
                        ) : (
                          <span className="text-mute">—</span>
                        )}
                      </td>
                      <td><RatePerMile load={load} /></td>
                      <td>
                        <Pill tone={STATUS_TONE[load.status] ?? 'neutral'}>
                          {pretty(load.status)}
                        </Pill>
                        {load.cancelledReason && (
                          <span className="mt-1 block max-w-48 text-xs break-words text-mute">
                            {load.cancelledReason}
                          </span>
                        )}
                        {canWrite && (
                          <span className="mt-1.5 block"><StatusControl load={load} /></span>
                        )}
                      </td>
                      <td>
                        {canWrite ? (
                          <AssignControl load={load} trucks={trucks.data?.items ?? []} />
                        ) : (
                          <span className="text-sm text-slate">{load.truckLabel ?? '—'}</span>
                        )}
                        {load.driverName && (
                          <span className="mt-1 block text-xs text-mute">{load.driverName}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <LoadMore
          onClick={() => loads.fetchNextPage()}
          loading={loads.isFetchingNextPage}
          hasMore={loads.hasNextPage}
        />
      </Card>

      <div ref={detailRef} className="space-y-6">
        {selectedId && <LoadMarginDetail loadId={selectedId} />}
        {selectedId && canWrite && (
          <TrackingLink
            loadId={selectedId}
            reference={items.find((l) => l.id === selectedId)?.reference ?? 0}
          />
        )}
        {selectedId && canWrite && (
          <CheckinLink
            loadId={selectedId}
            reference={items.find((l) => l.id === selectedId)?.reference ?? 0}
            drivers={drivers.data?.items ?? []}
            currentDriverId={items.find((l) => l.id === selectedId)?.driverId ?? null}
          />
        )}
        {selectedId &&
          canWrite &&
          (() => {
            const selected = items.find((l) => l.id === selectedId);
            if (!selected) return null;
            // Keyed on the load: this component's edit state is seeded from
            // props only once, on mount, same reasoning `VerifyBroker`'s own
            // key comment gives — switching to a different load has to remount it.
            return <EditLoadStops key={selected.id} load={selected} />;
          })()}
        {selectedId &&
          canWrite &&
          (() => {
            const selected = items.find((l) => l.id === selectedId);
            if (!selected) return null;
            return <CheckFeasibility load={selected} trucks={trucks.data?.items ?? []} />;
          })()}
        {selectedId &&
          canWrite &&
          (() => {
            const selected = items.find((l) => l.id === selectedId);
            if (!selected?.brokerId || !selected.brokerName) return null;
            return (
              // Keyed on the broker, not the load: switching to a different
              // load for the same broker should not remount, but switching
              // brokers must — the input's initial value only reads its prop
              // once, on mount.
              <>
                <VerifyBroker
                  key={`verify-${selected.brokerId}`}
                  brokerId={selected.brokerId}
                  brokerName={selected.brokerName}
                />
                <DetentionThreshold
                  key={selected.brokerId}
                  brokerId={selected.brokerId}
                  brokerName={selected.brokerName}
                  freeMinutes={selected.brokerDetentionFreeMinutes}
                />
              </>
            );
          })()}
      </div>
    </div>
  );
}
