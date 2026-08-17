-- The event log is append-only, and that is enforced here rather than agreed
-- in code review.
--
-- Guardrail 6 requires an immutable log of recommendations, decisions,
-- messages, document changes and financial actions. A log the application can
-- edit with the same credential it writes with is not immutable; it is a table
-- that nobody has edited yet. The distinction only ever matters once, during a
-- dispute, months later, with money attached.
--
-- Two layers:
--
--   1. A trigger that raises on UPDATE and DELETE. Applies to every role
--      including the owner, so it survives a developer with a psql prompt and
--      a good reason.
--
--   2. Revoked grants on the application role, so the attempt fails at the
--      permission check and never reaches the trigger. Belt and braces,
--      because layer 1 can be disabled with ALTER TABLE ... DISABLE TRIGGER
--      and layer 2 cannot be, by a role that lacks ownership.
--
-- Corrections are made by appending a compensating event, the way a ledger
-- does. There is no other supported path.

create or replace function event_log_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'event_log is append-only (attempted %). Append a compensating event instead.',
    tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists event_log_no_update_trg on event_log;
create trigger event_log_no_update_trg
  before update on event_log
  for each row execute function event_log_reject_mutation();

drop trigger if exists event_log_no_delete_trg on event_log;
create trigger event_log_no_delete_trg
  before delete on event_log
  for each row execute function event_log_reject_mutation();

-- Layer 2. The application connects as `haulq_app` in every environment above
-- local. Skipped silently when the role is absent so a developer's throwaway
-- database still migrates.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'haulq_app') then
    revoke update, delete, truncate on event_log from haulq_app;
    grant insert, select on event_log to haulq_app;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Hash chain
-- ---------------------------------------------------------------------------
--
-- Each event hashes its own contents together with the previous event's hash,
-- per org. Editing event 400 of 900 then requires recomputing 500 hashes, and
-- a verification pass that walks the chain will notice if that was not done.
--
-- This defends against someone who holds DDL rights — who can drop the
-- triggers above — which is exactly the person whose edits an audit trail
-- needs to be able to detect. It does not prevent tampering. It makes silent
-- tampering impractical, which is the achievable goal.
--
-- Computed in a BEFORE INSERT trigger so the value cannot be supplied by the
-- caller. Anything the application could set, the application could forge.

create or replace function event_log_chain_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev text;
begin
  select hash into v_prev
    from event_log
   where org_id = new.org_id
   order by seq desc
   limit 1;

  new.prev_hash := v_prev;

  -- Canonical serialization. Column order here is the contract; changing it
  -- invalidates every hash written before the change, so append new fields at
  -- the end rather than inserting them in the middle.
  new.hash := encode(
    digest(
      coalesce(v_prev, '')
        || '|' || new.org_id::text
        || '|' || new.occurred_at::text
        || '|' || new.actor_type::text
        || '|' || coalesce(new.actor_id, '')
        || '|' || new.verb
        || '|' || new.subject_type
        || '|' || coalesce(new.subject_id::text, '')
        || '|' || new.explanation
        || '|' || new.data::text,
      'sha256'
    ),
    'hex'
  );

  return new;
end;
$$;

drop trigger if exists event_log_chain_hash_trg on event_log;
create trigger event_log_chain_hash_trg
  before insert on event_log
  for each row execute function event_log_chain_hash();

-- Walks one org's chain and returns the first sequence number whose hash does
-- not reproduce. Returns no rows when the chain is intact. Run it in CI against
-- a seeded database, and on a schedule in production.
create or replace function verify_event_chain(p_org_id uuid)
returns table (broken_seq bigint, reason text)
language plpgsql
as $$
declare
  r          record;
  v_prev     text := null;
  v_expected text;
begin
  for r in
    select * from event_log where org_id = p_org_id order by seq asc
  loop
    if r.prev_hash is distinct from v_prev then
      broken_seq := r.seq;
      reason := 'prev_hash does not match the preceding event';
      return next;
      return;
    end if;

    v_expected := encode(
      digest(
        coalesce(v_prev, '')
          || '|' || r.org_id::text
          || '|' || r.occurred_at::text
          || '|' || r.actor_type::text
          || '|' || coalesce(r.actor_id, '')
          || '|' || r.verb
          || '|' || r.subject_type
          || '|' || coalesce(r.subject_id::text, '')
          || '|' || r.explanation
          || '|' || r.data::text,
        'sha256'
      ),
      'hex'
    );

    if r.hash is distinct from v_expected then
      broken_seq := r.seq;
      reason := 'contents do not reproduce the stored hash';
      return next;
      return;
    end if;

    v_prev := r.hash;
  end loop;
end;
$$;
