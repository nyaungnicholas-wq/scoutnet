CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "discovery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"run_id" uuid,
	"provider" text NOT NULL,
	"vertical" text NOT NULL,
	"location" text NOT NULL,
	"radius_miles" integer DEFAULT 25 NOT NULL,
	"min_score" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"qualified" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"vertical" text NOT NULL,
	"location" text NOT NULL,
	"provider" text NOT NULL,
	"requested" integer DEFAULT 0 NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"qualified" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"min_score" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"mode" text NOT NULL,
	"ok" boolean DEFAULT false NOT NULL,
	"detail" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"run_id" uuid,
	"business_name" text NOT NULL,
	"vertical" text DEFAULT 'generic' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"maps_url" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"signals" jsonb,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"income_score" integer DEFAULT 0 NOT NULL,
	"need_score" integer DEFAULT 0 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"primary_gap" text DEFAULT 'none' NOT NULL,
	"draft_subject" text DEFAULT '' NOT NULL,
	"draft_body" text DEFAULT '' NOT NULL,
	"draft_edited" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"dedupe_key" text NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"next_followup_at" timestamp with time zone,
	"last_touch_at" timestamp with time zone,
	"verify_status" text DEFAULT 'unverified' NOT NULL,
	"verify_score" integer,
	"verify_provider" text,
	"verified_at" timestamp with time zone,
	"provider_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"email" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"granted_scopes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"history_id" text,
	"last_polled_at" timestamp with time zone,
	"warmup_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"to_addr" text NOT NULL,
	"from_addr" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"sent_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"business_name" text DEFAULT '' NOT NULL,
	"owner_name" text DEFAULT '' NOT NULL,
	"business_phone" text DEFAULT '' NOT NULL,
	"business_address" text DEFAULT '' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"offer" text DEFAULT 'custom websites and done-for-you marketing' NOT NULL,
	"accent" text DEFAULT '#0369a1' NOT NULL,
	"resend_key_enc" text,
	"from_addr" text DEFAULT '' NOT NULL,
	"reply_to" text DEFAULT '' NOT NULL,
	"auto_send_threshold" integer DEFAULT 80 NOT NULL,
	"followups_enabled" boolean DEFAULT true NOT NULL,
	"daily_cap" integer DEFAULT 25 NOT NULL,
	"warmup_started_at" timestamp with time zone,
	"auth_check" jsonb,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text DEFAULT 'unsubscribed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verified_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verify_token_hash" text,
	"verify_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_sends" ADD CONSTRAINT "lead_sends_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_sends" ADD CONSTRAINT "lead_sends_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_addresses" ADD CONSTRAINT "verified_addresses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_jobs_account_idx" ON "discovery_jobs" USING btree ("account_id","status","created_at");--> statement-breakpoint
CREATE INDEX "discovery_runs_account_idx" ON "discovery_runs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_send_step_unique" ON "lead_sends" USING btree ("lead_id","ordinal");--> statement-breakpoint
CREATE INDEX "lead_sends_cap_idx" ON "lead_sends" USING btree ("account_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_account_dedupe_unique" ON "leads" USING btree ("account_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "leads_account_status_idx" ON "leads" USING btree ("account_id","status","score");--> statement-breakpoint
CREATE INDEX "leads_thread_idx" ON "leads" USING btree ("account_id","provider_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_account_email_unique" ON "mailbox_connections" USING btree ("account_id","email");--> statement-breakpoint
CREATE INDEX "outbox_account_idx" ON "outbox_emails" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_unique" ON "suppressions" USING btree ("account_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_addr_unique" ON "verified_addresses" USING btree ("account_id","email");