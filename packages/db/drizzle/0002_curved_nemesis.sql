CREATE TABLE "load_checkin_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"load_id" uuid NOT NULL,
	"driver_id" uuid,
	"token_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "load_visibility_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"load_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "truck_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "load_checkin_links" ADD CONSTRAINT "load_checkin_links_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_checkin_links" ADD CONSTRAINT "load_checkin_links_load_id_loads_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_checkin_links" ADD CONSTRAINT "load_checkin_links_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_checkin_links" ADD CONSTRAINT "load_checkin_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_visibility_links" ADD CONSTRAINT "load_visibility_links_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_visibility_links" ADD CONSTRAINT "load_visibility_links_load_id_loads_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_visibility_links" ADD CONSTRAINT "load_visibility_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_positions" ADD CONSTRAINT "truck_positions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_positions" ADD CONSTRAINT "truck_positions_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "load_checkin_links_token_key" ON "load_checkin_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "load_checkin_links_org_idx" ON "load_checkin_links" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "load_checkin_links_load_idx" ON "load_checkin_links" USING btree ("load_id");--> statement-breakpoint
CREATE UNIQUE INDEX "load_visibility_links_token_key" ON "load_visibility_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "load_visibility_links_org_idx" ON "load_visibility_links" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "load_visibility_links_load_idx" ON "load_visibility_links" USING btree ("load_id");--> statement-breakpoint
CREATE INDEX "truck_positions_org_idx" ON "truck_positions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "truck_positions_truck_recorded_idx" ON "truck_positions" USING btree ("truck_id","recorded_at");