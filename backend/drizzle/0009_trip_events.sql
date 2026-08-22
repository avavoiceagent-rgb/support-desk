CREATE TYPE "public"."trip_event_kind" AS ENUM('CREATED', 'UPDATED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "trip_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"actor_user_id" text,
	"actor_name" text NOT NULL,
	"kind" "trip_event_kind" NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_events_trip_idx" ON "trip_events" USING btree ("trip_id","created_at");