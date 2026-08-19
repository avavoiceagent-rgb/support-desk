ALTER TABLE "tickets" ADD COLUMN "reservation_type" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "reservation_source" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "auto_classified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "classification_reason" text;
