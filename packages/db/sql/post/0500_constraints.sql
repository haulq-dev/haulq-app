-- Check constraints for the open-ended columns.
--
-- These are the fields deliberately typed as `text` rather than an enum,
-- because their value set grows on someone else's schedule (a new load board, a
-- new document type a broker invents). A check constraint keeps them honest
-- without making every addition a Drizzle migration and a deploy.

-- --- money ------------------------------------------------------------------
--
-- Build plan section 5: never floats near an invoice. Amounts are integer minor
-- units, so the only way to get a fractional cent into this database is a bug,
-- and the only way to get an ambiguous amount is a null currency beside a
-- non-null value.

-- The loop is also the enforcement of the convention itself: an `_amount`
-- column with no `_currency` sibling stops the migration with a message naming
-- the column, rather than shipping an amount whose units nobody can recover.
-- Use `money()` from `_shared.ts` and this never fires.

do $$
declare
  r record;
  v_currency text;
begin
  for r in
    select c.relname as tbl, a.attname as col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = current_schema()
       and c.relkind = 'r'
       and a.attname like '%\_amount'
       and not a.attisdropped
  loop
    v_currency := replace(r.col, '_amount', '_currency');

    if not exists (
      select 1
        from pg_attribute a2
        join pg_class c2 on c2.oid = a2.attrelid
        join pg_namespace n2 on n2.oid = c2.relnamespace
       where n2.nspname = current_schema()
         and c2.relname = r.tbl
         and a2.attname = v_currency
         and not a2.attisdropped
    ) then
      raise exception
        'money convention: %.% has no matching % column. Use money() from _shared.ts.',
        r.tbl, r.col, v_currency;
    end if;

    execute format(
      'alter table %I drop constraint if exists %I',
      r.tbl, r.tbl || '_' || r.col || '_currency_ck');
    execute format(
      'alter table %I add constraint %I check (%I is null or %I is not null)',
      r.tbl,
      r.tbl || '_' || r.col || '_currency_ck',
      r.col,
      v_currency);
  end loop;
end;
$$;

-- --- documents --------------------------------------------------------------

alter table documents drop constraint if exists documents_kind_ck;
alter table documents add constraint documents_kind_ck check (
  kind in (
    'rate_confirmation',
    'bol',
    'pod',
    'invoice',
    'lumper_receipt',
    'scale_ticket',
    'weight_ticket',
    'insurance_certificate',
    'w9',
    'carrier_packet',
    'detention_evidence',
    'other'
  )
);

alter table documents drop constraint if exists documents_kind_confidence_range;
alter table documents add constraint documents_kind_confidence_range check (
  kind_confidence is null or (kind_confidence >= 0 and kind_confidence <= 1)
);

-- A rejected document must say why. The carrier is going to ask, and
-- "validation failed" is not an answer they can act on.
alter table documents drop constraint if exists documents_rejected_has_reason;
alter table documents add constraint documents_rejected_has_reason check (
  status <> 'rejected' or rejection_reason is not null
);

-- --- loads ------------------------------------------------------------------

alter table loads drop constraint if exists loads_source_board_ck;
alter table loads add constraint loads_source_board_ck check (
  source_board is null
  or source_board in ('DAT', 'DF', 'TRUCKSTOP', '123LB', 'MOCK')
);

-- Board-sourced rows carry the provider's retention deadline. Guardrail 4 is
-- unenforceable if a row can arrive from a board without one.
alter table loads drop constraint if exists loads_board_source_has_provenance;
alter table loads add constraint loads_board_source_has_provenance check (
  source <> 'load_board'
  or (source_board is not null and source_fetched_at is not null)
);

alter table loads drop constraint if exists loads_miles_source_ck;
alter table loads add constraint loads_miles_source_ck check (
  miles_source is null or miles_source in ('board', 'haversine', 'routing')
);

alter table loads drop constraint if exists loads_miles_non_negative;
alter table loads add constraint loads_miles_non_negative check (
  coalesce(expected_deadhead_miles, 0) >= 0
  and coalesce(expected_loaded_miles, 0) >= 0
  and coalesce(actual_deadhead_miles, 0) >= 0
  and coalesce(actual_loaded_miles, 0) >= 0
);

-- --- trucks -----------------------------------------------------------------

alter table trucks drop constraint if exists trucks_position_source_ck;
alter table trucks add constraint trucks_position_source_ck check (
  position_source is null
  or position_source in ('eld', 'driver_app', 'manual')
);

-- A position without a timestamp is not a position. Build plan section 2b's
-- whole point about ELD coverage being patchy for short-haul-exempt box trucks
-- depends on being able to tell fresh data from stale.
alter table trucks drop constraint if exists trucks_position_has_timestamp;
alter table trucks add constraint trucks_position_has_timestamp check (
  (current_lat is null and current_lng is null)
  or (position_at is not null and position_source is not null)
);

-- --- stops ------------------------------------------------------------------

alter table load_stops drop constraint if exists load_stops_arrival_source_ck;
alter table load_stops add constraint load_stops_arrival_source_ck check (
  arrival_source is null
  or arrival_source in ('geofence', 'driver_app', 'eld', 'manual')
);

alter table load_stops drop constraint if exists load_stops_window_ordered;
alter table load_stops add constraint load_stops_window_ordered check (
  window_start is null or window_end is null or window_end >= window_start
);

-- --- board credentials ------------------------------------------------------
--
-- The dispatcher schema's design note, kept: a leaked database must not hand
-- over the carrier's DAT login. `secret_ref` is a pointer into Doppler. This
-- constraint is a blunt instrument against the day someone "temporarily" pastes
-- a real credential into it.
alter table board_credentials drop constraint if exists board_credentials_ref_is_pointer;
alter table board_credentials add constraint board_credentials_ref_is_pointer check (
  secret_ref ~ '^[a-zA-Z0-9_/.:-]+$' and length(secret_ref) <= 200
);

alter table board_credentials drop constraint if exists board_credentials_status_ck;
alter table board_credentials add constraint board_credentials_status_ck check (
  status in ('unverified', 'active', 'failed', 'revoked')
);
