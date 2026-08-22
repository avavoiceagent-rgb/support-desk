CREATE TABLE "affiliate_zones" (
	"id" text PRIMARY KEY NOT NULL,
	"affiliate_id" text NOT NULL,
	"label" text NOT NULL,
	"from_miles" integer DEFAULT 0 NOT NULL,
	"to_miles" integer,
	"minimum_hours" integer DEFAULT 2 NOT NULL,
	"rate_cents" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "base_address" text;--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "base_lat" double precision;--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "base_lng" double precision;--> statement-breakpoint
ALTER TABLE "affiliate_zones" ADD CONSTRAINT "affiliate_zones_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affiliate_zones_affiliate_idx" ON "affiliate_zones" USING btree ("affiliate_id","sort_order");