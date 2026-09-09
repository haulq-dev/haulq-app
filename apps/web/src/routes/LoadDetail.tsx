/**
 * A single load's detail — everything that used to live inline below the
 * loads table, now its own page. See `Loads.tsx`'s module note for the
 * table itself; this file owns what happens once a dispatcher picks one row.
 *
 * Fetches the load directly by id rather than relying on the list screen's
 * query having already loaded it, so a bookmark or a direct link works with
 * no prior visit to `/loads`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiRequestError, request, type Driver, type Truck } from '../lib/api.ts';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, Label, Money, Num, Pill } from '../components/ui.tsx';
import { pretty, STATUS_TONE, CoordinateLookup, type Load } from './Loads.tsx';
import type { LoadFeasibilityResponse } from '@haulq/contracts';

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
        reads. A stop with a city and state fills its coordinates in on its
        own below — nothing to click. Both coordinate fields are needed
        together, or leave both blank.
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
                  {stop.city && stop.state.length === 2 && (
                    <CoordinateLookup
                      address={{
                        ...(stop.addressLine1 ? { addressLine1: stop.addressLine1 } : {}),
                        city: stop.city,
                        state: stop.state,
                        ...(stop.postalCode ? { postalCode: stop.postalCode } : {}),
                      }}
                      hasCoordinates={Boolean(v.lat && v.lng)}
                      onPick={(c) =>
                        setValues((prev) => ({
                          ...prev,
                          [stop.id]: { ...prev[stop.id]!, lat: String(c.lat), lng: String(c.lng) },
                        }))
                      }
                    />
                  )}
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
  recheckEnabled: boolean;
  nextRecheckDue: string | null;
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
          {info.data.verification.source}.{' '}
          {info.data.nextRecheckDue ? (
            <>Due for automatic re-check {new Date(info.data.nextRecheckDue).toLocaleString()}.</>
          ) : (
            <>Automatic re-checks are not turned on for this deployment.</>
          )}
        </p>
      )}

      <ErrorNote error={saveDocket.error ?? verify.error} />
    </Card>
  );
}

interface BrokerDocumentHistory {
  consideredCount: number;
  manualCount: number;
}

/**
 * Purely informational — a heads-up for whoever is about to upload this
 * broker's next document, not a signal anything in the pipeline acts on.
 * See `brokerDocumentHistory`'s own comment (`@haulq/db`) for why nothing
 * here changes automated behavior: it would mean skipping a read that
 * might have succeeded, on the strength of a pattern rather than a fact
 * about the specific document in hand.
 */
function BrokerDocumentHistoryNote({ brokerId }: { brokerId: string }) {
  const history = useQuery({
    queryKey: ['broker-document-history', brokerId],
    queryFn: () => request<BrokerDocumentHistory>(`/v1/brokers/${brokerId}/document-history`),
  });

  if (!history.data || history.data.consideredCount === 0) return null;
  const { consideredCount, manualCount } = history.data;
  if (manualCount === 0) return null;

  return (
    <p className="px-1 text-xs text-mute">
      This broker's paperwork has needed manual correction {manualCount} of the last{' '}
      {consideredCount} time{consideredCount === 1 ? '' : 's'}.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Driver-reported tracking
// ---------------------------------------------------------------------------

interface TrackingStopView {
  seq: number;
  type: string;
  city: string;
  state: string;
  facilityName: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  arrivedAt: string | null;
  loadingStartedAt: string | null;
  loadingEndedAt: string | null;
  departedAt: string | null;
  detentionMinutes: number | null;
  stillOnSite: boolean;
}

interface LoadTrackingView {
  orgName: string;
  loadReference: number;
  status: string;
  equipment: string;
  truck: {
    label: string | null;
    currentCity: string | null;
    currentState: string | null;
    currentLat: number | null;
    currentLng: number | null;
    positionAt: string | null;
  } | null;
  stops: TrackingStopView[];
  eta: { stopSeq: number; milesRemaining: number; arrivalAt: string } | null;
}

/** "3 hours ago", "just now" — coarse on purpose, this is a freshness signal, not a clock. Same wording `Track.tsx`'s broker page already uses. */
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

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function DetentionBadge({ stop }: { stop: TrackingStopView }) {
  if (stop.detentionMinutes === null) return null;
  if (stop.detentionMinutes === 0) {
    return stop.stillOnSite ? <Pill tone="neutral">on time so far</Pill> : null;
  }
  return (
    <Pill tone="warn">
      {stop.stillOnSite ? 'in detention' : 'was in detention'} — {formatMinutes(stop.detentionMinutes)} over
    </Pill>
  );
}

function TrackingStopRow({ stop }: { stop: TrackingStopView }) {
  const checkpoints: Array<{ label: string; at: string | null }> = [
    { label: 'Arrived', at: stop.arrivedAt },
    { label: 'Loading started', at: stop.loadingStartedAt },
    { label: 'Loading ended', at: stop.loadingEndedAt },
    { label: 'Departed', at: stop.departedAt },
  ];
  const reached = checkpoints.filter((c) => c.at);

  return (
    <li className="border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="field-label text-brand">
            {stop.type === 'pickup' ? 'Pickup' : 'Delivery'}
          </span>
          <p className="mt-0.5">
            {stop.facilityName ? `${stop.facilityName} — ` : ''}
            {stop.city}, {stop.state}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DetentionBadge stop={stop} />
          {stop.windowStart && (
            <span className="text-xs text-mute">Appointment {when(stop.windowStart)}</span>
          )}
        </div>
      </div>

      {reached.length > 0 ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          {checkpoints.map((c) => (
            <div key={c.label}>
              <dt className="field-label text-mute">{c.label}</dt>
              <dd className="mt-0.5 text-sm">{c.at ? when(c.at) : '—'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 text-sm text-mute">Not there yet.</p>
      )}
    </li>
  );
}

/**
 * What a broker's tracking link already shows (`Track.tsx`), reused for the
 * carrier's own team — plus the truck's precise coordinates, which the
 * broker view deliberately never exposes. See `GET /v1/loads/:id/tracking`'s
 * module note.
 */
function TrackingPanel({ loadId, reference }: { loadId: string; reference: number }) {
  const tracking = useQuery({
    queryKey: ['load-tracking', loadId],
    queryFn: () => request<LoadTrackingView>(`/v1/loads/${loadId}/tracking`),
  });

  if (tracking.isLoading) return null;
  if (!tracking.data) return null;
  const t = tracking.data;

  return (
    <Card
      title={`Load ${reference} — driver-reported progress`}
      action={<Pill tone={STATUS_TONE[t.status] ?? 'neutral'}>{pretty(t.status)}</Pill>}
    >
      <div className="mb-4 border-b border-line pb-4">
        {t.truck ? (
          <div>
            <p>{t.truck.label}</p>
            {t.truck.currentCity ? (
              <p className="mt-1 text-sm text-slate">
                {t.truck.currentCity}, {t.truck.currentState}
                {t.truck.currentLat !== null && t.truck.currentLng !== null && (
                  <span className="num ml-2 text-xs text-mute">
                    {t.truck.currentLat.toFixed(4)}, {t.truck.currentLng.toFixed(4)}
                  </span>
                )}
                {t.truck.positionAt && (
                  <span className="ml-2 text-xs text-mute">{relativeAge(t.truck.positionAt)}</span>
                )}
              </p>
            ) : (
              <p className="mt-1 text-sm text-mute">No position reported yet.</p>
            )}
            {t.eta && (
              <p className="mt-2 text-sm text-slate">
                Estimated arrival at stop {t.eta.stopSeq}:{' '}
                <span className="num font-medium text-ink">{when(t.eta.arrivalAt)}</span>
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-mute">No truck assigned yet.</p>
        )}
      </div>

      {t.stops.length === 0 ? (
        <Empty>No stops on this load.</Empty>
      ) : (
        <ul>
          {t.stops.map((stop) => (
            <TrackingStopRow key={stop.seq} stop={stop} />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function LoadDetailScreen() {
  const { loadId } = useParams({ from: '/loads/$loadId' });
  const session = useSession();
  const orgs = useOrgs();

  const load = useQuery({
    queryKey: ['load', loadId],
    queryFn: () => request<Load>(`/v1/loads/${loadId}`),
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

  if (load.isError) {
    return (
      <div className="space-y-6">
        <Link to="/loads" className="text-sm text-brand underline">
          ← Back to loads
        </Link>
        <ErrorNote error={load.error} />
      </div>
    );
  }

  if (!load.data) return null;
  const l = load.data;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/loads" className="text-sm text-brand underline">
          ← Back to loads
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl">Load {l.reference}</h1>
          <Pill tone={STATUS_TONE[l.status] ?? 'neutral'}>{pretty(l.status)}</Pill>
        </div>
        <p className="mt-1 text-slate">{l.brokerName ?? 'No broker'}</p>
      </div>

      <LoadMarginDetail loadId={l.id} />
      <TrackingPanel loadId={l.id} reference={l.reference} />

      {canWrite && <TrackingLink loadId={l.id} reference={l.reference} />}
      {canWrite && (
        <CheckinLink
          loadId={l.id}
          reference={l.reference}
          drivers={drivers.data?.items ?? []}
          currentDriverId={l.driverId}
        />
      )}
      {canWrite && <EditLoadStops key={l.id} load={l} />}
      {canWrite && <CheckFeasibility load={l} trucks={trucks.data?.items ?? []} />}
      {canWrite && l.brokerId && l.brokerName && (
        <>
          <VerifyBroker key={`verify-${l.brokerId}`} brokerId={l.brokerId} brokerName={l.brokerName} />
          <DetentionThreshold
            key={l.brokerId}
            brokerId={l.brokerId}
            brokerName={l.brokerName}
            freeMinutes={l.brokerDetentionFreeMinutes}
          />
          <BrokerDocumentHistoryNote key={`doc-history-${l.brokerId}`} brokerId={l.brokerId} />
        </>
      )}
    </div>
  );
}
