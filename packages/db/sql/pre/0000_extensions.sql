-- Extensions. Runs before any table is created.
--
-- pgcrypto is needed twice over: gen_random_uuid() for primary keys, and
-- digest() for the event log's hash chain in post/0200.
create extension if not exists "pgcrypto";

-- PostGIS and pgvector are in the stack (build plan section 5) but not in
-- Phase 0. PostGIS arrives with Routes; pgvector with HaulQ IQ's knowledge
-- base. Adding them now would mean every developer and every CI runner needs a
-- Postgres image carrying two extensions nothing yet queries.
--
--   create extension if not exists postgis;   -- Phase 3
--   create extension if not exists vector;    -- HaulQ IQ
