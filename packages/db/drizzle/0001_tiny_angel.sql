CREATE TYPE "public"."factoring_packet_status" AS ENUM('assembling', 'submitted', 'accepted', 'rejected', 'funded');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."payment_source" AS ENUM('factor', 'broker_direct');--> statement-breakpoint
CREATE TABLE "factoring_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"submission_method" text DEFAULT 'email' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "factoring_companies_org_name_key" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "factoring_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"factoring_company_id" uuid NOT NULL,
	"status" "factoring_packet_status" DEFAULT 'assembling' NOT NULL,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"load_id" uuid NOT NULL,
	"reference" integer DEFAULT 0 NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"source_document_id" uuid,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_amount" bigint NOT NULL,
	"total_currency" char(3) DEFAULT 'USD' NOT NULL,
	"due_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "invoices_org_reference_key" UNIQUE("org_id","reference")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"factoring_packet_id" uuid,
	"payment_amount" bigint NOT NULL,
	"payment_currency" char(3) DEFAULT 'USD' NOT NULL,
	"source" "payment_source" NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "factoring_companies" ADD CONSTRAINT "factoring_companies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factoring_packets" ADD CONSTRAINT "factoring_packets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factoring_packets" ADD CONSTRAINT "factoring_packets_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factoring_packets" ADD CONSTRAINT "factoring_packets_factoring_company_id_factoring_companies_id_fk" FOREIGN KEY ("factoring_company_id") REFERENCES "public"."factoring_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_load_id_loads_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_factoring_packet_id_factoring_packets_id_fk" FOREIGN KEY ("factoring_packet_id") REFERENCES "public"."factoring_packets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "factoring_companies_org_idx" ON "factoring_companies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "factoring_packets_org_idx" ON "factoring_packets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "factoring_packets_org_status_idx" ON "factoring_packets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "factoring_packets_invoice_idx" ON "factoring_packets" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "factoring_packets_factoring_company_idx" ON "factoring_packets" USING btree ("factoring_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_load_key" ON "invoices" USING btree ("load_id") WHERE status <> 'void';--> statement-breakpoint
CREATE INDEX "invoices_org_status_idx" ON "invoices" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "invoices_org_due_idx" ON "invoices" USING btree ("org_id","due_at");--> statement-breakpoint
CREATE INDEX "invoices_source_document_idx" ON "invoices" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "payments_org_idx" ON "payments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payments_org_received_idx" ON "payments" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_factoring_packet_idx" ON "payments" USING btree ("factoring_packet_id");