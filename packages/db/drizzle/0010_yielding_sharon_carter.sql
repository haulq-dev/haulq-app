CREATE TYPE "public"."org_plan" AS ENUM('carrier', 'fleet');--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "plan" "org_plan";--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_stripe_customer_id_key" ON "orgs" USING btree ("stripe_customer_id");