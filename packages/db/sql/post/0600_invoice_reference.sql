-- Per-org sequential invoice numbers.
--
-- Same reasoning as `0100_load_reference.sql`: "Invoice 214" is what goes on
-- a factoring packet's cover sheet and what a broker's AP department asks
-- for on the phone. A uuid is neither, and a global sequence would tell one
-- carrier how many invoices another has sent.
--
-- Shares `org_counters` with loads rather than a new table — one row per org
-- either way, and a second single-column-update table would exist only to
-- avoid adding one column to this one.

alter table org_counters add column if not exists invoice_next bigint not null default 1;

create or replace function next_invoice_reference(p_org_id uuid)
returns bigint
language plpgsql
as $$
declare
  v_next bigint;
begin
  insert into org_counters (org_id) values (p_org_id)
  on conflict (org_id) do nothing;

  update org_counters
     set invoice_next = invoice_next + 1
   where org_id = p_org_id
  returning invoice_next - 1 into v_next;

  return v_next;
end;
$$;

create or replace function invoices_assign_reference()
returns trigger
language plpgsql
as $$
begin
  if new.reference is null or new.reference = 0 then
    new.reference := next_invoice_reference(new.org_id);
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_assign_reference_trg on invoices;
create trigger invoices_assign_reference_trg
  before insert on invoices
  for each row execute function invoices_assign_reference();
