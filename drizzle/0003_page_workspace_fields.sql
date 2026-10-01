ALTER TABLE "page" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "font" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "small_text" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "full_width" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_live_updated_idx" ON "page" USING btree ("workspace_id","updated_at" DESC NULLS LAST) WHERE "page"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_icon_length" CHECK ("page"."icon" is null or char_length("page"."icon") between 1 and 16);--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_font_valid" CHECK ("page"."font" in ('default', 'serif', 'mono'));--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_trash_pair" CHECK (("page"."deleted_at" is null) = ("page"."deleted_by" is null));--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_icon_length" CHECK ("workspace"."icon" is null or char_length("workspace"."icon") between 1 and 16);