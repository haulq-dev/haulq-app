CREATE TABLE "autonomy_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"hold_reason" text,
	"channel" text DEFAULT 'email' NOT NULL,
	"to_addresses" jsonb NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"related_type" text,
	"related_id" uuid,
	"dedupe_key" text,
	"provider_message_id" text,
	"error" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD COLUMN "sending_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "autonomy_settings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autonomy_settings_org_action_key" ON "autonomy_settings" USING btree ("org_id","action_type");--> statement-breakpoint
CREATE INDEX "outbound_messages_org_created_idx" ON "outbound_messages" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_org_status_idx" ON "outbound_messages" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_messages_org_dedupe_key" ON "outbound_messages" USING btree ("org_id","dedupe_key") WHERE "outbound_messages"."dedupe_key" is not null;