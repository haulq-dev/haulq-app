CREATE TABLE "broker_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"broker_id" uuid NOT NULL,
	"source" text NOT NULL,
	"operating_status" text,
	"legal_name" text,
	"dba_name" text,
	"raw" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brokers" ADD COLUMN "latest_verification_id" uuid;--> statement-breakpoint
ALTER TABLE "broker_verifications" ADD CONSTRAINT "broker_verifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_verifications" ADD CONSTRAINT "broker_verifications_broker_id_brokers_id_fk" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broker_verifications_org_idx" ON "broker_verifications" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "broker_verifications_broker_checked_idx" ON "broker_verifications" USING btree ("broker_id","checked_at");