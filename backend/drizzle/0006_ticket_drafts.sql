CREATE TABLE IF NOT EXISTS "ticket_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"body_html" text NOT NULL,
	"confirmations" jsonb NOT NULL,
	"questions" jsonb NOT NULL,
	"internal_notes" jsonb NOT NULL,
	"rate" jsonb,
	"status" text DEFAULT 'READY' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_drafts_ticket_id_unique" UNIQUE("ticket_id")
);
--> statement-breakpoint
ALTER TABLE "ticket_drafts" ADD CONSTRAINT "ticket_drafts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
