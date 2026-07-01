ALTER TABLE "leads" ADD COLUMN "contact_source" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_tried" boolean DEFAULT false NOT NULL;
