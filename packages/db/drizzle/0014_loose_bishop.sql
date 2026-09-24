ALTER TABLE "outbound_messages" ADD COLUMN "review_verdict" text;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;