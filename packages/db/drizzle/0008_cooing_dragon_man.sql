DROP INDEX "loads_org_created_idx";--> statement-breakpoint
DROP INDEX "documents_unattached_idx";--> statement-breakpoint
CREATE INDEX "documents_org_received_idx" ON "documents" USING btree ("org_id","received_at","id");--> statement-breakpoint
CREATE INDEX "factoring_packets_org_created_idx" ON "factoring_packets" USING btree ("org_id","created_at","id");--> statement-breakpoint
CREATE INDEX "invoices_org_created_idx" ON "invoices" USING btree ("org_id","created_at","id");--> statement-breakpoint
CREATE INDEX "loads_org_created_idx" ON "loads" USING btree ("org_id","created_at","id");--> statement-breakpoint
CREATE INDEX "documents_unattached_idx" ON "documents" USING btree ("org_id","received_at","id") WHERE load_id is null;