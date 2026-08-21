ALTER TABLE "board_credentials" ALTER COLUMN "secret_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "board_credentials" ADD COLUMN "encrypted_access_token" text;--> statement-breakpoint
ALTER TABLE "board_credentials" ADD COLUMN "encrypted_refresh_token" text;--> statement-breakpoint
ALTER TABLE "board_credentials" ADD COLUMN "token_expires_at" timestamp with time zone;