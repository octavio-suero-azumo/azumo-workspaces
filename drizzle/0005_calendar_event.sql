-- Hand-edited after generation: the event→page FK uses ON DELETE SET NULL ("page_id")
-- (PostgreSQL >= 15) so deleting a page clears only the link, never workspace_id.
-- Drizzle cannot express a column list; see the note on `calendarEvent` in schema.ts.

CREATE TABLE "calendar_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"all_day" boolean NOT NULL,
	"start_date" date,
	"end_date" date,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"time_zone" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_title_length" CHECK (char_length("calendar_event"."title") between 1 and 200),
	CONSTRAINT "calendar_event_description_length" CHECK ("calendar_event"."description" is null or char_length("calendar_event"."description") <= 2000),
	CONSTRAINT "calendar_event_time_zone_length" CHECK ("calendar_event"."time_zone" is null or char_length("calendar_event"."time_zone") between 1 and 64),
	CONSTRAINT "calendar_event_shape" CHECK (("calendar_event"."all_day" and "calendar_event"."start_date" is not null and "calendar_event"."end_date" is not null and "calendar_event"."end_date" >= "calendar_event"."start_date" and "calendar_event"."start_at" is null and "calendar_event"."end_at" is null and "calendar_event"."time_zone" is null)
        or (not "calendar_event"."all_day" and "calendar_event"."start_at" is not null and "calendar_event"."end_at" is not null and "calendar_event"."end_at" > "calendar_event"."start_at" and "calendar_event"."time_zone" is not null and "calendar_event"."start_date" is null and "calendar_event"."end_date" is null))
);
--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_page_workspace_fk" FOREIGN KEY ("page_id","workspace_id") REFERENCES "public"."page"("id","workspace_id") ON DELETE SET NULL ("page_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_event_workspace_start_date_idx" ON "calendar_event" USING btree ("workspace_id","start_date");--> statement-breakpoint
CREATE INDEX "calendar_event_workspace_start_at_idx" ON "calendar_event" USING btree ("workspace_id","start_at");--> statement-breakpoint
CREATE INDEX "calendar_event_page_id_idx" ON "calendar_event" USING btree ("page_id");