-- Operations: drivers, vehicles, shifts, affiliates, trips, invoices.
--
-- Hand-trimmed after generation. drizzle-kit only had snapshots up to 0001,
-- because 0002-0006 were written by hand, so it believed ticket_drafts and the
-- triage columns on tickets did not exist yet and tried to create them again.
-- 0007_snapshot.json is a true picture of the whole schema, so a future
-- `drizzle-kit generate` will diff correctly from here.

CREATE TYPE "public"."assigned_to_kind" AS ENUM('DRIVER', 'AFFILIATE', 'UNASSIGNED');
--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'SENT', 'PAID', 'DISPUTED', 'VOID');
--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
--> statement-breakpoint
CREATE TYPE "public"."vehicle_class" AS ENUM('SEDAN', 'SUV', 'VAN', 'SPRINTER');
--> statement-breakpoint
CREATE TABLE "affiliates" (
	"id" text PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"contact_name" text,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"coverage_states" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage_cities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overflow_partner" boolean DEFAULT false NOT NULL,
	"hourly_rate_usd" integer,
	"preference" integer DEFAULT 3 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_shifts" (
	"id" text PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"vehicle_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"unavailable" boolean DEFAULT false NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"default_vehicle_id" text,
	"licence_number" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity_tenths" integer DEFAULT 10 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"trip_id" text,
	"bill_to_name" text NOT NULL,
	"bill_to_email" text NOT NULL,
	"issued_on" timestamp with time zone NOT NULL,
	"due_on" timestamp with time zone,
	"status" "invoice_status" DEFAULT 'SENT' NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"paid_on" timestamp with time zone,
	"dispute_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"ticket_id" text,
	"passenger_name" text NOT NULL,
	"passenger_phone" text,
	"booker_name" text,
	"booker_email" text,
	"pickup_address" text NOT NULL,
	"dropoff_address" text NOT NULL,
	"stops" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pickup_at" timestamp with time zone NOT NULL,
	"booked_hours" integer DEFAULT 2 NOT NULL,
	"actual_hours" integer,
	"vehicle_class" "vehicle_class" NOT NULL,
	"passenger_count" integer,
	"luggage_count" integer,
	"flight_number" text,
	"status" "trip_status" DEFAULT 'SCHEDULED' NOT NULL,
	"assigned_kind" "assigned_to_kind" DEFAULT 'UNASSIGNED' NOT NULL,
	"driver_id" text,
	"vehicle_id" text,
	"affiliate_id" text,
	"farm_out_reason" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trips_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"class" "vehicle_class" NOT NULL,
	"make_model" text NOT NULL,
	"plate" text NOT NULL,
	"passenger_capacity" integer NOT NULL,
	"luggage_capacity" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_default_vehicle_id_vehicles_id_fk" FOREIGN KEY ("default_vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "driver_shifts_driver_start_idx" ON "driver_shifts" USING btree ("driver_id","starts_at");
--> statement-breakpoint
CREATE INDEX "trips_pickup_idx" ON "trips" USING btree ("pickup_at");
--> statement-breakpoint
CREATE INDEX "trips_driver_pickup_idx" ON "trips" USING btree ("driver_id","pickup_at");
--> statement-breakpoint
CREATE INDEX "trips_booker_email_idx" ON "trips" USING btree ("booker_email");
