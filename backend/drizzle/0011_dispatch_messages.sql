CREATE TYPE "public"."dispatch_direction" AS ENUM('OUT', 'IN');--> statement-breakpoint
CREATE TYPE "public"."dispatch_kind" AS ENUM('OFFER', 'ACCEPT', 'DECLINE', 'TEXT');--> statement-breakpoint
CREATE TABLE "dispatch_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text,
	"driver_id" text,
	"affiliate_id" text,
	"direction" "dispatch_direction" NOT NULL,
	"kind" "dispatch_kind" DEFAULT 'TEXT' NOT NULL,
	"body" text NOT NULL,
	"responds_to_id" text,
	"author_user_id" text,
	"author_name" text,
	"acted_by_user_id" text,
	"acted_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispatch_messages" ADD CONSTRAINT "dispatch_messages_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_messages" ADD CONSTRAINT "dispatch_messages_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_messages" ADD CONSTRAINT "dispatch_messages_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_messages" ADD CONSTRAINT "dispatch_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_messages" ADD CONSTRAINT "dispatch_messages_acted_by_user_id_users_id_fk" FOREIGN KEY ("acted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_driver_idx" ON "dispatch_messages" USING btree ("driver_id","created_at");--> statement-breakpoint
CREATE INDEX "dispatch_affiliate_idx" ON "dispatch_messages" USING btree ("affiliate_id","created_at");--> statement-breakpoint
CREATE INDEX "dispatch_trip_idx" ON "dispatch_messages" USING btree ("trip_id","created_at");