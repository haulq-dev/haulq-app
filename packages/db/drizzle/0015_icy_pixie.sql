CREATE TABLE "load_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text NOT NULL,
	"fields" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"gaps" jsonb NOT NULL,
	"matched_load_id" uuid,
	"created_load_id" uuid,
	"model" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "load_proposals" ADD CONSTRAINT "load_proposals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_proposals" ADD CONSTRAINT "load_proposals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_proposals" ADD CONSTRAINT "load_proposals_matched_load_id_loads_id_fk" FOREIGN KEY ("matched_load_id") REFERENCES "public"."loads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_proposals" ADD CONSTRAINT "load_proposals_created_load_id_loads_id_fk" FOREIGN KEY ("created_load_id") REFERENCES "public"."loads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_proposals" ADD CONSTRAINT "load_proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "load_proposals_document_key" ON "load_proposals" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "load_proposals_org_status_idx" ON "load_proposals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "load_proposals_org_created_idx" ON "load_proposals" USING btree ("org_id","created_at");