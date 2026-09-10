-- SantaCruz mirror: five new tables, nothing existing altered.
--
-- Hand-trimmed after generating. drizzle-kit wanted to re-apply the
-- dispatch_kind values and the trips columns that migrations 0019 and 0020
-- already added by hand — running those a second time fails on deploy, and a
-- failed migration takes the whole release with it. Only the SantaCruz
-- statements are kept here; the snapshot beside this file records the rest as
-- already applied, which they are.

CREATE TYPE "public"."santacruz_import_source" AS ENUM('FILE', 'API');
--> statement-breakpoint
CREATE TABLE "santacruz_bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"reference" text,
	"passenger_name" text,
	"passenger_phone" text,
	"booker_name" text,
	"booker_email" text,
	"pickup_address" text,
	"dropoff_address" text,
	"pickup_at" timestamp,
	"booked_hours" double precision,
	"vehicle_class" text,
	"passenger_count" integer,
	"luggage_count" integer,
	"flight_number" text,
	"status" text,
	"driver_name" text,
	"price_cents" integer,
	"notes" text,
	"raw" jsonb NOT NULL,
	"ticket_id" text,
	"import_id" text,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "santacruz_connection" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"base_url" text,
	"source_time_zone" text DEFAULT 'America/New_York' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_checked_at" timestamp,
	"last_check_result" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "santacruz_field_map" (
	"id" text PRIMARY KEY NOT NULL,
	"source_column" text NOT NULL,
	"target_field" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "santacruz_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"source" "santacruz_import_source" NOT NULL,
	"label" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"rows_seen" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_rejected" integer DEFAULT 0 NOT NULL,
	"error" text,
	"actor_user_id" text,
	"actor_name" text
);
--> statement-breakpoint
CREATE TABLE "santacruz_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"external_id" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "santacruz_bookings" ADD CONSTRAINT "santacruz_bookings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "santacruz_bookings" ADD CONSTRAINT "santacruz_bookings_import_id_santacruz_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."santacruz_imports"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "santacruz_imports" ADD CONSTRAINT "santacruz_imports_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "santacruz_rejections" ADD CONSTRAINT "santacruz_rejections_import_id_santacruz_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."santacruz_imports"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "santacruz_bookings_external_key" ON "santacruz_bookings" USING btree ("external_id");
--> statement-breakpoint
CREATE INDEX "santacruz_bookings_pickup_idx" ON "santacruz_bookings" USING btree ("pickup_at");
--> statement-breakpoint
CREATE INDEX "santacruz_bookings_reference_idx" ON "santacruz_bookings" USING btree ("reference");
--> statement-breakpoint
CREATE INDEX "santacruz_bookings_ticket_idx" ON "santacruz_bookings" USING btree ("ticket_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "santacruz_map_target_key" ON "santacruz_field_map" USING btree ("target_field");
--> statement-breakpoint
CREATE UNIQUE INDEX "santacruz_map_source_key" ON "santacruz_field_map" USING btree ("source_column");
--> statement-breakpoint
CREATE INDEX "santacruz_rejections_import_idx" ON "santacruz_rejections" USING btree ("import_id","row_number");
