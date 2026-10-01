CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_blob_pathname_unique" UNIQUE("blob_pathname"),
	CONSTRAINT "attachment_kind_valid" CHECK ("attachment"."kind" in ('upload')),
	CONSTRAINT "attachment_display_name_length" CHECK (char_length("attachment"."display_name") between 1 and 255),
	CONSTRAINT "attachment_blob_pathname_prefix" CHECK (starts_with("attachment"."blob_pathname", 'ws/' || "attachment"."workspace_id"::text || '/pg/' || "attachment"."page_id"::text || '/')),
	CONSTRAINT "attachment_size_non_negative" CHECK ("attachment"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_page_workspace_fk" FOREIGN KEY ("page_id","workspace_id") REFERENCES "public"."page"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_page_id_idx" ON "attachment" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "attachment_workspace_id_idx" ON "attachment" USING btree ("workspace_id");