ALTER TABLE "tickets" ALTER COLUMN "requester_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "status" SET DEFAULT 'OPEN';--> statement-breakpoint
UPDATE "tickets" SET "status" = 'RESOLVED_CLOSED' WHERE "status" = 'CLOSED';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "requester_phone" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "queue" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "channel" text DEFAULT 'EMAIL' NOT NULL;--> statement-breakpoint
DROP TYPE "public"."ticket_status";
