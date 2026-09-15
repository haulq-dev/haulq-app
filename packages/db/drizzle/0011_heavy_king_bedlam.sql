CREATE TABLE "mailbox_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text DEFAULT 'unipile' NOT NULL,
	"unipile_account_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_org_key" ON "mailbox_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mailbox_connections_org_idx" ON "mailbox_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_account_id_key" ON "mailbox_connections" USING btree ("unipile_account_id") WHERE "mailbox_connections"."unipile_account_id" is not null;