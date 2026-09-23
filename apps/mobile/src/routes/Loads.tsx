/**
 * Loads, for owners, dispatchers and accountants. The web `Loads.tsx` screen
 * redrawn for a phone (MOBILE_PARITY_PLAN.md M1).
 *
 * Same rules as web:
 * - **Rate per total mile is the headline, not per loaded mile.** Deadhead
 *   is what decides whether a load is good, so the flattering number sits
 *   beside it in grey (`ratePerMile`'s note in `@haulq/client`).
 * - Status counts are org-wide, from the first page, so a chip shows how many
 *   loads sit at that status, not how many happen to be loaded on screen.
 *
 * One change from web: status changes and truck/driver assignment live on the
 * load's own screen, not inline in the list. A row of dropdowns per card
 * doesn't fit a phone, and moving a load is a considered tap, not a
 * scroll-by edit.
 *
 * Drivers never see this screen. `Home.tsx` sends them to `MyLoads.tsx`.
 */

import { Link } from '@tanstack/react-router';
import { LOAD_STATUSES, type LoadStatus } from '@haulq/contracts';
import {
  canDispatch,
  laneEnds,
  LOAD_STATUS_TONE,
  prettyStatus,
  ratePerMile,
  formatMoney,
  THIN_RATE_CENTS_PER_MILE,
  useLoads,
  type Load,
} from '@haulq/client';
import { useEffect, useState } from 'react';
import { useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, LoadMore, Money, Pill } from '../components/ui.tsx';

/** Typing pause before a search re-queries the list. */
const SEARCH_DEBOUNCE_MS = 400;

export function LoadsScreen() {
  const session = useSession();
  const [status, setStatus] = useState<LoadStatus | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  const loads = useLoads({ status, search });
  const items = loads.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = loads.data?.pages[0]?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl">Loads</h1>
          {session?.orgName && <p className="text-sm text-mute">{session.orgName}</p>}
        </div>
        {canDispatch(session?.role) && (
          <Link to="/loads/new" className="hq-btn hq-btn-brand active:scale-100" aria-label="Add a load">
            + Add
          </Link>
        )}
      </div>

      <input
        type="search"
        className="hq-input"
        placeholder="Search broker, load #, or reference"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />

      {/* Chips scroll sideways rather than wrap: nine statuses on a phone
          would otherwise push the list off the first screen. */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Filter by status">
        <Chip active={status === ''} onClick={() => setStatus('')} label="All" count={total} />
        {LOAD_STATUSES.filter((s) => counts[s]).map((s) => (
          <Chip key={s} active={status === s} onClick={() => setStatus(s)} label={prettyStatus(s)} count={counts[s] ?? 0} />
        ))}
      </div>

      {loads.isError && <ErrorNote error={loads.error} />}
      {loads.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {loads.data && items.length === 0 && (
        <div className="hq-card p-4">
          <Empty>
            {search ? `Nothing matches "${search}".` : status ? `Nothing at ${prettyStatus(status)}.` : 'No loads yet.'}
          </Empty>
        </div>
      )}

      <ul className="space-y-3">
        {items.map((load) => (
          <li key={load.id}>
            <LoadCard load={load} />
          </li>
        ))}
      </ul>

      <LoadMore onClick={() => void loads.fetchNextPage()} loading={loads.isFetchingNextPage} hasMore={loads.hasNextPage} />
    </div>
  );
}

function Chip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`hq-pill shrink-0 gap-1.5 whitespace-nowrap px-3 py-1.5 text-[0.8125rem] capitalize ${
        active ? 'bg-ink text-white' : 'bg-card text-slate shadow-[inset_0_0_0_1px_var(--color-line)]'
      }`}
    >
      {label}{' '}
      <span className={`num ${active ? 'text-white/70' : 'text-mute'}`}>{count}</span>
    </button>
  );
}

function LoadCard({ load }: { load: Load }) {
  const { pickup, delivery } = laneEnds(load.stops);
  const rates = ratePerMile(load);

  return (
    <Link to="/loads/$loadId" params={{ loadId: load.id }} className="block">
      <Card>
        <div className="flex items-center justify-between gap-2">
          <span className="num text-lg font-semibold">Load {load.reference}</span>
          <Pill tone={LOAD_STATUS_TONE[load.status] ?? 'neutral'}>{prettyStatus(load.status)}</Pill>
        </div>
        <p className="mt-0.5 text-sm text-mute">{load.brokerName ?? 'No broker'}</p>

        <p className="mt-2 text-[0.9375rem]">
          {pickup ? `${pickup.city}, ${pickup.state}` : '—'}
          <span className="text-mute"> → </span>
          {delivery ? `${delivery.city}, ${delivery.state}` : '—'}
        </p>
        {load.expectedLoadedMiles !== null && (
          <p className="num text-xs text-mute">
            {load.expectedLoadedMiles.toLocaleString()} loaded
            {load.expectedDeadheadMiles !== null && ` · ${load.expectedDeadheadMiles.toLocaleString()} deadhead`}
          </p>
        )}

        <div className="mt-3 flex items-end justify-between gap-3 border-t border-line pt-3">
          <div>
            {load.rateAmount !== null ? (
              <span className="text-base font-semibold">
                <Money cents={load.rateAmount} />
              </span>
            ) : (
              <span className="text-sm text-mute">No rate</span>
            )}
            {load.rateIsLinehaul && <span className="block text-xs text-warn">linehaul only</span>}
          </div>
          <div className="text-right">
            {rates ? (
              <>
                <span className={`num text-base ${rates.total < THIN_RATE_CENTS_PER_MILE ? 'text-warn' : 'text-ink'}`}>
                  {formatMoney(rates.total)}
                </span>
                <span className="text-xs text-mute">/total mi</span>
                <span className="num block text-xs text-mute">{formatMoney(rates.loaded)} loaded</span>
              </>
            ) : (
              <span className="text-xs text-mute">
                {load.expectedLoadedMiles === null ? 'no miles' : 'no deadhead recorded'}
              </span>
            )}
          </div>
        </div>

        {(load.truckLabel || load.driverName) && (
          <p className="mt-2 text-xs text-slate">
            {load.truckLabel ?? 'No truck'}
            {load.driverName && <span className="text-mute"> · {load.driverName}</span>}
          </p>
        )}
        {load.cancelledReason && <p className="mt-2 text-xs text-mute">{load.cancelledReason}</p>}
      </Card>
    </Link>
  );
}
