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
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { canTransition, LOAD_STATUSES, nextStatuses, type LoadStatus } from '@haulq/contracts';
import { request, type Truck } from '../lib/api.ts';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, LoadMore, Money, Num, Pill } from '../components/ui.tsx';

export interface Stop {
  id: string;
  seq: number;
  type: 'pickup' | 'delivery';
  city: string;
  state: string;
  facilityName: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface Load {
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

export const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  delivered: 'ok',
  invoiced: 'ok',
  paid: 'ok',
  cancelled: 'warn',
};

export const pretty = (s: string) => s.replace(/_/g, ' ');

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

interface GeocodeCandidate {
  label: string;
  lat: number;
  lng: number;
  score: number;
}

/**
 * A typed address turned into coordinates, confirmed by hand before it fills
 * anything in — see `apps/api/src/routes/geocode.ts`'s module note for why
 * this never auto-fills a match without the dispatcher picking it. Used by
 * both `AddLoad` (a fresh stop) and `EditLoadStops` (an existing stop's
 * already-stored address).
 */
/**
 * Above this, a HERE match reads as a real place nobody needs to double-check.
 * Below it — or with a second candidate too close to call — the coordinates
 * still fill in immediately (silence stays the point; a dispatcher should
 * never have to click just to get a first answer), but the other candidates
 * stay visible underneath as a correction a dispatcher can act on if the
 * guess is wrong. Nothing here is ever silently trusted forever: a bad guess
 * is always sitting right there to fix, which is what actually protects
 * against the wrong-feasibility-verdict failure `here-geocode.ts`'s own
 * module note describes — not withholding a first answer.
 */
const AUTO_ACCEPT_SCORE = 0.7;
/** How much a top match has to clear the runner-up by, on top of the score bar above, before its alternates stop being worth showing at all. */
const AUTO_ACCEPT_MARGIN = 0.15;
/** Typing pause before an automatic lookup fires, so it runs once after a dispatcher stops, not once per keystroke. */
const AUTO_LOOKUP_DEBOUNCE_MS = 700;

export function CoordinateLookup({
  address,
  hasCoordinates,
  onPick,
}: {
  address: { addressLine1?: string; city: string; state: string; postalCode?: string };
  /** True once lat/lng are set, however they got set — auto-resolved, picked, or typed by hand. Lookups stop firing on their own once this is true, so a manual entry is never silently overwritten. */
  hasCoordinates: boolean;
  onPick: (candidate: GeocodeCandidate) => void;
}) {
  // The alternates to a pick already applied — not "candidates awaiting a
  // decision." Coordinates are filled in the moment a lookup resolves,
  // confident or not; this is only ever a correction list sitting underneath
  // that already-filled answer, never a gate in front of it.
  const [alternates, setAlternates] = useState<GeocodeCandidate[]>([]);
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null);
  const [noMatch, setNoMatch] = useState(false);

  const canLookup = address.city.trim() !== '' && address.state.trim().length === 2;

  const lookup = useMutation({
    mutationFn: () =>
      request<{ candidates: GeocodeCandidate[] }>(
        `/v1/geocode?${new URLSearchParams({
          ...(address.addressLine1 ? { addressLine1: address.addressLine1 } : {}),
          city: address.city,
          state: address.state,
          ...(address.postalCode ? { postalCode: address.postalCode } : {}),
        })}`,
      ),
    onSuccess: (res) => {
      const [top, runnerUp] = res.candidates;
      if (!top) {
        setNoMatch(true);
        setResolvedLabel(null);
        setAlternates([]);
        return;
      }

      const clearWinner =
        top.score >= AUTO_ACCEPT_SCORE && (!runnerUp || top.score - runnerUp.score >= AUTO_ACCEPT_MARGIN);

      setNoMatch(false);
      setResolvedLabel(top.label);
      setAlternates(clearWinner ? [] : res.candidates.filter((c) => c !== top));
      onPick(top);
    },
  });

  // Runs once, quietly, the moment a stop has enough address to try — the
  // coordinates fill in with no click at all. Skipped entirely once they
  // exist, so it never fires again over a manual edit or an earlier pick;
  // clearing a stop's coordinates (or changing the address before any were
  // set) is what lets it try again.
  useEffect(() => {
    if (!canLookup || hasCoordinates || lookup.isPending) return;
    const id = setTimeout(() => lookup.mutate(), AUTO_LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(id);
    // Re-runs on every address field, not just city/state — a street address
    // or postal code typed after the debounce already fired is exactly the
    // case a dispatcher would expect to sharpen the match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address.addressLine1, address.city, address.state, address.postalCode, hasCoordinates]);

  const pick = (c: GeocodeCandidate) => {
    setResolvedLabel(c.label);
    setAlternates((prev) => prev.filter((a) => a !== c));
    onPick(c);
  };

  return (
    <div className="mt-1.5">
      {resolvedLabel && (
        <p className="text-xs text-mute">
          Coordinates filled in automatically, matched to{' '}
          <span className="text-slate">{resolvedLabel}</span>.{' '}
          <button
            type="button"
            className="text-brand underline disabled:cursor-not-allowed disabled:text-mute disabled:no-underline"
            disabled={!canLookup || lookup.isPending}
            onClick={() => {
              setResolvedLabel(null);
              setAlternates([]);
              lookup.mutate();
            }}
          >
            Not the right spot? Search again
          </button>
        </p>
      )}
      {!resolvedLabel && (
        <button
          type="button"
          className="text-xs text-brand underline disabled:cursor-not-allowed disabled:text-mute disabled:no-underline"
          disabled={!canLookup || lookup.isPending}
          onClick={() => {
            setNoMatch(false);
            lookup.mutate();
          }}
        >
          {lookup.isPending ? 'Filling in coordinates…' : 'Fill in coordinates from this address'}
        </button>
      )}
      <ErrorNote error={lookup.error} />
      {noMatch && (
        <p className="mt-1 text-xs text-mute">
          No address matched that — coordinates were not filled in. Enter them directly below, or adjust
          the address above and this will try again.
        </p>
      )}
      {alternates.length > 0 && (
        <div className="mt-1.5 border-l-2 border-line pl-2">
          <p className="text-xs text-mute">
            That match wasn't a clear best guess — if it's wrong, click the correct address below to
            replace the coordinates with it:
          </p>
          <ul className="mt-1 space-y-1">
            {alternates.map((c, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="text-left text-xs text-slate underline decoration-dotted hover:text-ink hover:decoration-solid"
                  onClick={() => pick(c)}
                >
                  Use {c.label} instead
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AddLoad({ trucks, onDone }: { trucks: Truck[]; onDone: () => void }) {
  const [brokerName, setBroker] = useState('');
  const [rate, setRate] = useState('');
  const [loadedMiles, setLoadedMiles] = useState('');
  const [deadheadMiles, setDeadhead] = useState('');
  const [commodity, setCommodity] = useState('');
  const [weightLbs, setWeight] = useState('');
  const [hazmat, setHazmat] = useState(false);
  const [status, setStatus] = useState<LoadStatus>('prospect');
  const [truckId, setTruckId] = useState('');
  const [pickup, setPickup] = useState({ addressLine1: '', postalCode: '', city: '', state: '', lat: '', lng: '' });
  const [delivery, setDelivery] = useState({ addressLine1: '', postalCode: '', city: '', state: '', lat: '', lng: '', windowEnd: '' });

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
          ...(hazmat ? { hazmat: true } : {}),
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
              ...(pickup.addressLine1 ? { addressLine1: pickup.addressLine1 } : {}),
              ...(pickup.postalCode ? { postalCode: pickup.postalCode } : {}),
              ...(pickup.lat && pickup.lng ? { lat: Number(pickup.lat), lng: Number(pickup.lng) } : {}),
            },
            {
              type: 'delivery',
              city: delivery.city,
              state: delivery.state,
              ...(delivery.addressLine1 ? { addressLine1: delivery.addressLine1 } : {}),
              ...(delivery.postalCode ? { postalCode: delivery.postalCode } : {}),
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
        <Field label="Pickup street address" hint="Optional — sharpens the automatic coordinate lookup below, in case the city alone is ambiguous.">
          <input className="hq-input" value={pickup.addressLine1} onChange={(e) => setPickup({ ...pickup, addressLine1: e.target.value })} />
        </Field>
        <Field label="Pickup postal code">
          <input className="hq-input" value={pickup.postalCode} onChange={(e) => setPickup({ ...pickup, postalCode: e.target.value })} />
        </Field>
        <Field label="Delivery street address">
          <input className="hq-input" value={delivery.addressLine1} onChange={(e) => setDelivery({ ...delivery, addressLine1: e.target.value })} />
        </Field>
        <Field label="Delivery postal code">
          <input className="hq-input" value={delivery.postalCode} onChange={(e) => setDelivery({ ...delivery, postalCode: e.target.value })} />
        </Field>
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-4">
        <Field label="Pickup coordinates" hint="Fills in on its own from the city and state above — lets HaulQ Routes check feasibility on this load.">
          <div className="flex gap-2">
            <input className="hq-input" data-numeric="true" inputMode="decimal" placeholder="lat" value={pickup.lat} onChange={(e) => setPickup({ ...pickup, lat: e.target.value })} />
            <input className="hq-input" data-numeric="true" inputMode="decimal" placeholder="lng" value={pickup.lng} onChange={(e) => setPickup({ ...pickup, lng: e.target.value })} />
          </div>
          <CoordinateLookup
            address={pickup}
            hasCoordinates={Boolean(pickup.lat && pickup.lng)}
            onPick={(c) => setPickup({ ...pickup, lat: String(c.lat), lng: String(c.lng) })}
          />
        </Field>
        <Field label="Delivery coordinates" hint="Fills in on its own too. Both stops need one for a feasibility check to run at all.">
          <div className="flex gap-2">
            <input className="hq-input" data-numeric="true" inputMode="decimal" placeholder="lat" value={delivery.lat} onChange={(e) => setDelivery({ ...delivery, lat: e.target.value })} />
            <input className="hq-input" data-numeric="true" inputMode="decimal" placeholder="lng" value={delivery.lng} onChange={(e) => setDelivery({ ...delivery, lng: e.target.value })} />
          </div>
          <CoordinateLookup
            address={delivery}
            hasCoordinates={Boolean(delivery.lat && delivery.lng)}
            onPick={(c) => setDelivery({ ...delivery, lat: String(c.lat), lng: String(c.lng) })}
          />
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

      <label className="mt-5 flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5 accent-[--color-brand]"
          checked={hazmat}
          onChange={(e) => setHazmat(e.target.checked)}
        />
        <span>
          <span className="block text-sm font-medium">Hazmat</span>
          <span className="block text-xs text-mute">
            Placarded freight. Reaches HaulQ Routes' feasibility check, which then screens
            for hazmat-restricted roads and tunnels along the route.
          </span>
        </span>
      </label>

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

export function LoadsScreen() {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<LoadStatus | ''>('');
  const session = useSession();
  const orgs = useOrgs();

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
                    <tr key={load.id}>
                      <td>
                        <Link
                          to="/loads/$loadId"
                          params={{ loadId: load.id }}
                          className="num block text-left font-medium hover:underline"
                        >
                          {load.reference}
                        </Link>
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
    </div>
  );
}
