-- updated_at, maintained by the database.
--
-- Every ORM offers to do this in application code. The reason not to: the CSV
-- importer writes in bulk with raw SQL, the retention job writes with raw SQL,
-- and a migration will eventually write with raw SQL. All three would leave
-- `updated_at` stale, and `updated_at` is what the sync layer for the driver
-- app will key off. One trigger is cheaper than remembering.

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = current_schema()
       and c.relkind = 'r'
       and a.attname = 'updated_at'
       and not a.attisdropped
  loop
    execute format('drop trigger if exists set_updated_at_trg on %I', t);
    execute format(
      'create trigger set_updated_at_trg before update on %I
         for each row execute function set_updated_at()', t);
  end loop;
end;
$$;
