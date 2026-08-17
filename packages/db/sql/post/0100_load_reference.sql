-- Per-org sequential load numbers.
--
-- "Load 1042" is what gets said on the phone and written on a rate
-- confirmation. A uuid is not, and a global sequence would tell every carrier
-- how many loads every other carrier has run.
--
-- Implemented with a counter row and `update ... returning` rather than
-- `max(reference) + 1`. The max approach reads and writes without a lock and
-- hands the same number to two concurrent inserts; the update takes a row lock
-- and serializes them. Under contention the second insert waits a few
-- microseconds, which is the correct trade for a number that must be unique.

create table if not exists org_counters (
  org_id     uuid primary key references orgs(id) on delete cascade,
  load_next  bigint not null default 1
);

create or replace function next_load_reference(p_org_id uuid)
returns bigint
language plpgsql
as $$
declare
  v_next bigint;
begin
  insert into org_counters (org_id) values (p_org_id)
  on conflict (org_id) do nothing;

  update org_counters
     set load_next = load_next + 1
   where org_id = p_org_id
  returning load_next - 1 into v_next;

  return v_next;
end;
$$;

create or replace function loads_assign_reference()
returns trigger
language plpgsql
as $$
begin
  -- Only when the caller did not supply one. CSV import sets its own so a
  -- carrier's historical load numbers survive the migration.
  if new.reference is null or new.reference = 0 then
    new.reference := next_load_reference(new.org_id);
  end if;
  return new;
end;
$$;

drop trigger if exists loads_assign_reference_trg on loads;
create trigger loads_assign_reference_trg
  before insert on loads
  for each row execute function loads_assign_reference();
