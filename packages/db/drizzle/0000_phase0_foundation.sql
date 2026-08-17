CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'agent', 'integration');--> statement-breakpoint
CREATE TYPE "public"."document_source" AS ENUM('email_intake', 'upload', 'driver_app', 'api', 'generated');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('received', 'classifying', 'extracting', 'extracted', 'validated', 'rejected', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."equipment_type" AS ENUM('STRAIGHT_BOX', 'DRY_VAN', 'REEFER', 'FLATBED', 'POWER_ONLY', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('pending', 'valid', 'invalid', 'committed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'mapping', 'validating', 'ready', 'committing', 'committed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."load_source" AS ENUM('load_board', 'broker_email', 'manual', 'csv_import', 'api');--> statement-breakpoint
CREATE TYPE "public"."load_status" AS ENUM('prospect', 'quoted', 'booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'dispatcher', 'driver', 'accountant');--> statement-breakpoint
CREATE TYPE "public"."org_status" AS ENUM('trialing', 'active', 'past_due', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('carrier', 'broker', 'shipper');--> statement-breakpoint
CREATE TYPE "public"."stop_type" AS ENUM('pickup', 'delivery');--> statement-breakpoint
CREATE TABLE "board_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"board" text NOT NULL,
	"secret_ref" text NOT NULL,
	"end_user_email" text,
	"status" text DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"carrier_owned_seat" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "board_credentials_org_board_key" UNIQUE("org_id","board")
);
--> statement-breakpoint
CREATE TABLE "carrier_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"dba_name" text,
	"mc_number" text,
	"usdot_number" text,
	"ein_last4" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"operating_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"operating_facts_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "org_role" DEFAULT 'driver' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" DEFAULT 'driver' NOT NULL,
	"status" "membership_status" DEFAULT 'invited' NOT NULL,
	"invited_by_user_id" uuid,
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "org_memberships_org_user_key" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "org_type" DEFAULT 'carrier' NOT NULL,
	"status" "org_status" DEFAULT 'trialing' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"sending_domain" text,
	"sending_domain_verified_at" timestamp with time zone,
	"entitlements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"monthly_usage_cap_amount" bigint,
	"monthly_usage_cap_currency" char(3) DEFAULT 'USD',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_auth_id" text NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"phone" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"full_name" text NOT NULL,
	"phone" text,
	"email" text,
	"cdl_number" text,
	"cdl_state" text,
	"cdl_expires_at" timestamp with time zone,
	"medical_card_expires_at" timestamp with time zone,
	"endorsements" text[] DEFAULT '{}' NOT NULL,
	"default_truck_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trucks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"equipment" "equipment_type" DEFAULT 'STRAIGHT_BOX' NOT NULL,
	"vin" text,
	"plate_state" text,
	"plate_number" text,
	"max_weight_lbs" integer,
	"max_length_ft" integer,
	"box_height_in" integer,
	"box_width_in" integer,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_per_mile_cents" integer,
	"avg_mpg" double precision,
	"current_city" text,
	"current_state" text,
	"current_lat" double precision,
	"current_lng" double precision,
	"position_source" text,
	"position_at" timestamp with time zone,
	"available_from" timestamp with time zone,
	"short_haul_exempt" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "trucks_org_label_key" UNIQUE("org_id","label")
);
--> statement-breakpoint
CREATE TABLE "brokers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mc_number" text,
	"usdot_number" text,
	"email" text,
	"phone" text,
	"website" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"payment_terms_days" integer,
	"notes" text,
	"board_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_load_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "brokers_org_name_mc_key" UNIQUE("org_id","name","mc_number")
);
--> statement-breakpoint
CREATE TABLE "load_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"load_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" "stop_type" NOT NULL,
	"facility_name" text,
	"address_line1" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text,
	"lat" double precision,
	"lng" double precision,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"appointment_required" boolean DEFAULT false NOT NULL,
	"appointment_number" text,
	"arrived_at" timestamp with time zone,
	"loading_started_at" timestamp with time zone,
	"loading_ended_at" timestamp with time zone,
	"departed_at" timestamp with time zone,
	"arrival_source" text,
	"reference_number" text,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "load_stops_load_seq_key" UNIQUE("load_id","seq")
);
--> statement-breakpoint
CREATE TABLE "loads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"reference" integer DEFAULT 0 NOT NULL,
	"status" "load_status" DEFAULT 'prospect' NOT NULL,
	"source" "load_source" NOT NULL,
	"source_board" text,
	"source_load_id" text,
	"source_fetched_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"broker_id" uuid,
	"broker_load_number" text,
	"equipment" "equipment_type" DEFAULT 'STRAIGHT_BOX' NOT NULL,
	"commodity" text,
	"weight_lbs" integer,
	"length_ft" integer,
	"piece_count" integer,
	"full_load" boolean DEFAULT true NOT NULL,
	"hazmat" boolean DEFAULT false NOT NULL,
	"requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comments" text,
	"rate_amount" bigint,
	"rate_currency" char(3) DEFAULT 'USD',
	"rate_is_linehaul" boolean DEFAULT false NOT NULL,
	"accessorials_amount" bigint,
	"accessorials_currency" char(3) DEFAULT 'USD',
	"accessorial_detail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_cost_amount" bigint,
	"expected_cost_currency" char(3) DEFAULT 'USD',
	"expected_margin_amount" bigint,
	"expected_margin_currency" char(3) DEFAULT 'USD',
	"actual_revenue_amount" bigint,
	"actual_revenue_currency" char(3) DEFAULT 'USD',
	"actual_cost_amount" bigint,
	"actual_cost_currency" char(3) DEFAULT 'USD',
	"actual_margin_amount" bigint,
	"actual_margin_currency" char(3) DEFAULT 'USD',
	"reconciled_at" timestamp with time zone,
	"expected_deadhead_miles" integer,
	"expected_loaded_miles" integer,
	"actual_deadhead_miles" integer,
	"actual_loaded_miles" integer,
	"miles_source" text,
	"truck_id" uuid,
	"driver_id" uuid,
	"booked_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "loads_org_reference_key" UNIQUE("org_id","reference"),
	CONSTRAINT "loads_org_source_key" UNIQUE("org_id","source_board","source_load_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"load_id" uuid,
	"kind" text DEFAULT 'other' NOT NULL,
	"kind_confidence" double precision,
	"status" "document_status" DEFAULT 'received' NOT NULL,
	"source" "document_source" NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text,
	"content_type" text,
	"byte_size" bigint,
	"sha256" text NOT NULL,
	"page_count" bigint,
	"received_from" text,
	"uploaded_by_user_id" uuid,
	"intake_message_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted" jsonb,
	"extracted_at" timestamp with time zone,
	"extractor_version" text,
	"validation" jsonb,
	"validated_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"actor_user_id" uuid,
	"verb" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"explanation" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" text,
	"prev_hash" text,
	"correlation_id" uuid,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"event_seq" bigint,
	"topic" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"entity" text DEFAULT 'loads' NOT NULL,
	"filename" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text,
	"column_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dialect" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"committed_rows" integer DEFAULT 0 NOT NULL,
	"uploaded_by_user_id" uuid,
	"committed_at" timestamp with time zone,
	"failed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"status" "import_row_status" DEFAULT 'pending' NOT NULL,
	"raw" jsonb NOT NULL,
	"parsed" jsonb,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"load_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_credentials" ADD CONSTRAINT "board_credentials_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_profiles" ADD CONSTRAINT "carrier_profiles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_default_truck_id_trucks_id_fk" FOREIGN KEY ("default_truck_id") REFERENCES "public"."trucks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brokers" ADD CONSTRAINT "brokers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_stops" ADD CONSTRAINT "load_stops_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_stops" ADD CONSTRAINT "load_stops_load_id_loads_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loads" ADD CONSTRAINT "loads_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loads" ADD CONSTRAINT "loads_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loads" ADD CONSTRAINT "loads_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loads" ADD CONSTRAINT "loads_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_load_id_loads_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_load_id_loads_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_profiles_org_key" ON "carrier_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "carrier_profiles_mc_idx" ON "carrier_profiles" USING btree ("mc_number");--> statement-breakpoint
CREATE INDEX "carrier_profiles_usdot_idx" ON "carrier_profiles" USING btree ("usdot_number");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invitations_token_key" ON "org_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "org_invitations_org_idx" ON "org_invitations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invitations_org_email_pending_key" ON "org_invitations" USING btree ("org_id","email") WHERE accepted_at is null and revoked_at is null;--> statement-breakpoint
CREATE INDEX "org_memberships_user_idx" ON "org_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "org_memberships_org_role_idx" ON "org_memberships" USING btree ("org_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_slug_key" ON "orgs" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "orgs_status_idx" ON "orgs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_auth_id_key" ON "users" USING btree ("external_auth_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "drivers_org_idx" ON "drivers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "drivers_org_active_idx" ON "drivers" USING btree ("org_id","active");--> statement-breakpoint
CREATE INDEX "drivers_user_idx" ON "drivers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trucks_org_idx" ON "trucks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "trucks_org_active_idx" ON "trucks" USING btree ("org_id","active");--> statement-breakpoint
CREATE INDEX "brokers_org_idx" ON "brokers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "brokers_org_mc_idx" ON "brokers" USING btree ("org_id","mc_number");--> statement-breakpoint
CREATE INDEX "brokers_org_blocked_idx" ON "brokers" USING btree ("org_id","blocked");--> statement-breakpoint
CREATE INDEX "load_stops_org_idx" ON "load_stops" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "load_stops_load_idx" ON "load_stops" USING btree ("load_id");--> statement-breakpoint
CREATE INDEX "load_stops_window_idx" ON "load_stops" USING btree ("org_id","window_start");--> statement-breakpoint
CREATE INDEX "loads_org_status_idx" ON "loads" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "loads_org_created_idx" ON "loads" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "loads_org_truck_idx" ON "loads" USING btree ("org_id","truck_id");--> statement-breakpoint
CREATE INDEX "loads_broker_idx" ON "loads" USING btree ("broker_id");--> statement-breakpoint
CREATE INDEX "loads_purge_idx" ON "loads" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "documents_org_status_idx" ON "documents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "documents_load_idx" ON "documents" USING btree ("load_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_org_sha_key" ON "documents" USING btree ("org_id","sha256");--> statement-breakpoint
CREATE INDEX "documents_unattached_idx" ON "documents" USING btree ("org_id","received_at") WHERE load_id is null;--> statement-breakpoint
CREATE INDEX "event_log_org_seq_idx" ON "event_log" USING btree ("org_id","seq");--> statement-breakpoint
CREATE INDEX "event_log_subject_idx" ON "event_log" USING btree ("org_id","subject_type","subject_id","seq");--> statement-breakpoint
CREATE INDEX "event_log_verb_idx" ON "event_log" USING btree ("org_id","verb","occurred_at");--> statement-breakpoint
CREATE INDEX "event_log_correlation_idx" ON "event_log" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "event_log_agent_idx" ON "event_log" USING btree ("org_id","seq") WHERE actor_type = 'agent';--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("available_at","seq") WHERE processed_at is null;--> statement-breakpoint
CREATE INDEX "event_outbox_org_idx" ON "event_outbox" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "import_batches_org_idx" ON "import_batches" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "import_batches_org_status_idx" ON "import_batches" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "import_rows_batch_idx" ON "import_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_batch_status_idx" ON "import_rows" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "import_rows_org_idx" ON "import_rows" USING btree ("org_id");