-- `org_invitations.driver_id` -> `drivers.id`.
--
-- Expressed here rather than as a Drizzle `.references()` on the column
-- itself: `fleet.ts` (drivers) already imports `orgs`/`users` from
-- `tenancy.ts` (org_invitations), and a reference back the other way would
-- make the two schema files circular. See the column's own comment in
-- `schema/tenancy.ts`.
--
-- `on delete set null` matches `loads.driver_id`'s own choice for the same
-- column elsewhere — removing a driver from the roster should not take a
-- historical invitation row down with it.

alter table org_invitations drop constraint if exists org_invitations_driver_id_fk;
alter table org_invitations add constraint org_invitations_driver_id_fk
  foreign key (driver_id) references drivers (id) on delete set null;
