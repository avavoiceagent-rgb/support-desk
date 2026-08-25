ALTER TYPE "dispatch_kind" ADD VALUE IF NOT EXISTS 'QUOTE_REQUEST';--> statement-breakpoint
ALTER TYPE "dispatch_kind" ADD VALUE IF NOT EXISTS 'QUOTE';--> statement-breakpoint
ALTER TABLE "dispatch_messages" ADD COLUMN "amount_cents" integer;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "partner_quote_cents" integer;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "customer_price_cents" integer;
