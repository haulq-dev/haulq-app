-- Load status transitions.
--
-- Enforced in the database because HaulQ Docs, Pay, Dispatch and the driver app
-- all write this column, and a rule that lives in one service's code is a rule
-- the other three will break. Section 13's warning about the load object being
-- un-retrofittable applies to its state machine as much as its columns.
--
-- The rule is: never backwards, and `cancelled` is reachable from anything that
-- has not been paid.
--
-- Not "forward exactly one step". Real loads skip — a carrier who books
-- directly from a broker email goes prospect → booked with nothing quoted, and
-- a short local run can go delivered → paid the same afternoon on a quick-pay.
-- Forbidding skips would mean the application inventing intermediate states to
-- satisfy the constraint, which teaches everyone that the states are decorative.

create or replace function load_status_ordinal(s load_status)
returns integer
language sql
immutable
as $$
  select case s
    when 'prospect'   then 10
    when 'quoted'     then 20
    when 'booked'     then 30
    when 'dispatched' then 40
    when 'in_transit' then 50
    when 'delivered'  then 60
    when 'invoiced'   then 70
    when 'paid'       then 80
    when 'cancelled'  then 90
  end;
$$;

create or replace function loads_check_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status = 'cancelled' then
    if old.status = 'paid' then
      raise exception
        'load % is paid and cannot be cancelled; record a reversal instead',
        old.reference
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if old.status = 'cancelled' then
    raise exception
      'load % is cancelled; reopening is not supported, create a new load',
      old.reference
      using errcode = 'restrict_violation';
  end if;

  if load_status_ordinal(new.status) < load_status_ordinal(old.status) then
    raise exception
      'load % cannot move backwards from % to %',
      old.reference, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists loads_check_status_transition_trg on loads;
create trigger loads_check_status_transition_trg
  before update of status on loads
  for each row execute function loads_check_status_transition();

-- ---------------------------------------------------------------------------
-- Consistency between status and its timestamps
-- ---------------------------------------------------------------------------
--
-- A load in `booked` with a null `booked_at` is a load nobody can invoice
-- correctly, and the gap tends to appear months later in an Insights query
-- rather than at the moment it is created.

alter table loads drop constraint if exists loads_booked_has_timestamp;
alter table loads add constraint loads_booked_has_timestamp check (
  load_status_ordinal(status) < 30
  or status = 'cancelled'
  or booked_at is not null
);

alter table loads drop constraint if exists loads_delivered_has_timestamp;
alter table loads add constraint loads_delivered_has_timestamp check (
  load_status_ordinal(status) < 60
  or status = 'cancelled'
  or delivered_at is not null
);

alter table loads drop constraint if exists loads_cancelled_has_timestamp;
alter table loads add constraint loads_cancelled_has_timestamp check (
  status <> 'cancelled' or cancelled_at is not null
);

-- A load past `booked` needs a truck. This is what makes "which trucks are
-- committed next Tuesday" answerable without a heuristic.
--
-- Imported history is exempt, and that exemption is load-bearing rather than a
-- convenience. Phase 0's exit gate is a carrier importing 30–90 days of real
-- loads (build plan section 4), and without that dataset the scoring weights
-- cannot be tuned at all (section 13). A carrier's export from their old system
-- frequently does not name which truck ran a load two months ago. Enforcing
-- this against history would mean either rejecting the import or inventing a
-- truck assignment, and inventing one poisons the per-truck economics that the
-- import exists to establish.
--
-- The exemption is narrow: `source = 'csv_import'` only. A load that HaulQ
-- dispatched itself always names a truck.
alter table loads drop constraint if exists loads_dispatched_has_truck;
alter table loads add constraint loads_dispatched_has_truck check (
  load_status_ordinal(status) < 40
  or status = 'cancelled'
  or source = 'csv_import'
  or truck_id is not null
);
