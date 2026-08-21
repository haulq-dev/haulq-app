-- Invoice status transitions.
--
-- Same reasoning as `0300_load_status.sql`: enforced in the database because
-- a route in `apps/api` and a future factor-status webhook both write this
-- column, and a rule that lives in one writer's code is a rule the other
-- will break.
--
-- The rule is: never backwards, and `void` is reachable from `draft` or
-- `sent` but not from `paid` — an invoice already paid is corrected with a
-- reversal (a negative-facing event and a new invoice), not by voiding one
-- money has already moved against.

create or replace function invoice_status_ordinal(s invoice_status)
returns integer
language sql
immutable
as $$
  select case s
    when 'draft' then 10
    when 'sent'  then 20
    when 'paid'  then 30
    when 'void'  then 40
  end;
$$;

create or replace function invoices_check_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status = 'void' then
    if old.status = 'paid' then
      raise exception
        'invoice % is paid and cannot be voided; record a reversal instead',
        old.reference
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if old.status = 'void' then
    raise exception
      'invoice % is void; reopening is not supported, issue a new invoice',
      old.reference
      using errcode = 'restrict_violation';
  end if;

  if invoice_status_ordinal(new.status) < invoice_status_ordinal(old.status) then
    raise exception
      'invoice % cannot move backwards from % to %',
      old.reference, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_check_status_transition_trg on invoices;
create trigger invoices_check_status_transition_trg
  before update of status on invoices
  for each row execute function invoices_check_status_transition();

-- ---------------------------------------------------------------------------
-- Consistency between status and its timestamps
-- ---------------------------------------------------------------------------

alter table invoices drop constraint if exists invoices_sent_has_timestamp;
alter table invoices add constraint invoices_sent_has_timestamp check (
  invoice_status_ordinal(status) < 20
  or status = 'void'
  or sent_at is not null
);

alter table invoices drop constraint if exists invoices_paid_has_timestamp;
alter table invoices add constraint invoices_paid_has_timestamp check (
  status <> 'paid' or paid_at is not null
);

alter table invoices drop constraint if exists invoices_void_has_timestamp_and_reason;
alter table invoices add constraint invoices_void_has_timestamp_and_reason check (
  status <> 'void' or (voided_at is not null and void_reason is not null)
);
