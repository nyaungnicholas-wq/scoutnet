import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type ProvenanceTag = "site" | "default" | "owner";

/** Result of a DNS-based sending-domain authentication check. `state` is
    "pass" when the record exists and is well-formed, "warn" when present but
    weak (e.g. DMARC p=none), "fail" when absent. */
export type AuthCheck = {
  domain: string;
  checkedAt: string;
  spf: { state: "pass" | "warn" | "fail"; detail: string };
  dkim: { state: "pass" | "warn" | "fail"; detail: string };
  dmarc: { state: "pass" | "warn" | "fail"; detail: string };
  mx: { state: "pass" | "warn" | "fail"; detail: string };
  score: number; // 0–100
};

/* ──────────────────────── account / auth / identity ────────────────────────
   Reused verbatim from the -Net infrastructure (LeadNet→ReachNet→ScoutNet):
   magic-link auth, an encrypted-key sender profile, verified reply-to addresses,
   a per-account suppression list, and a dev outbox. ScoutNet adds the discovery
   brain on top of this. */

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const magicTokens = pgTable("magic_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  email: text("email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* One sender profile per account — your outbound identity AND your offer. Outreach
   can only send through the owner's OWN Resend key + domain (resendKeyEnc/fromAddr);
   there is no shared-platform sending path for outreach, by design. The platform
   key is used for transactional mail only (magic links, address verification). */
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" })
    .unique(),
  businessName: text("business_name").notNull().default(""),
  ownerName: text("owner_name").notNull().default(""),
  businessPhone: text("business_phone").notNull().default(""),
  /** Physical postal address — CAN-SPAM requires it; sending is blocked without it. */
  businessAddress: text("business_address").notNull().default(""),
  website: text("website").notNull().default(""),
  /** One-line description of what you sell, woven into every draft. */
  offer: text("offer").notNull().default("custom websites and done-for-you marketing"),
  accent: text("accent").notNull().default("#0369a1"),
  /** Owner's own Resend key, AES-256-GCM encrypted at rest with APP_SECRET. */
  resendKeyEnc: text("resend_key_enc"),
  /** This account's Live Google Sheet webhook URL (Apps Script exec URL). Stored
      per-account and AES-256-GCM encrypted at rest — it's effectively a bearer URL
      for this tenant's full lead export, so it must never be a shared global value. */
  sheetWebhookEnc: text("sheet_webhook_enc"),
  /** From address on the owner's own verified domain, e.g. "Dana <dana@myagency.com>". */
  fromAddr: text("from_addr").notNull().default(""),
  /** Reply-to; must be a verified address. Empty = the login email. */
  replyTo: text("reply_to").notNull().default(""),
  /** Hybrid send mode: leads scoring >= this are eligible for auto-send by the
      dispatcher; everything below is held in the review queue for a human. */
  autoSendThreshold: integer("auto_send_threshold").notNull().default(80),
  /** When on, a lead that's been sent but hasn't replied gets timed follow-ups
      (a gentle bump, then a final note) before the sequence closes itself out. */
  followupsEnabled: boolean("followups_enabled").notNull().default(true),
  /** Owner-set daily outreach cap (the target the warm-up ramps toward); the
      dispatcher enforces min(this, the warm-up cap for today, env max). */
  dailyCap: integer("daily_cap").notNull().default(25),
  /** Stamped on the first outreach send. A new domain that jumps straight to
      volume gets flagged as a spammer, so the effective cap ramps from a low
      floor over the first weeks of sending. Null until the first send goes out. */
  warmupStartedAt: timestamp("warmup_started_at", { withTimezone: true }),
  /** Cached result of the last DNS deliverability preflight (SPF/DKIM/DMARC). */
  authCheck: jsonb("auth_check").$type<AuthCheck | null>(),
  /** Where each profile field came from, for the onboarding review screen. */
  provenance: jsonb("provenance").$type<Record<string, ProvenanceTag>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ───────────────────────────── discovery brain ─────────────────────────────
   A run is one "find me {vertical} in {location}" sweep. Each candidate becomes
   a lead, enriched with website/marketing signals and scored against the
   "stable income, weak digital presence" rubric. */

export type DiscoveryProvider = "places" | "osm" | "sample";

export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    vertical: text("vertical").notNull(),
    location: text("location").notNull(),
    provider: text("provider", { enum: ["places", "osm", "sample"] }).notNull(),
    requested: integer("requested").notNull().default(0),
    /** Candidates returned by the provider. */
    found: integer("found").notNull().default(0),
    /** Leads that cleared minScore. */
    qualified: integer("qualified").notNull().default(0),
    /** New leads inserted (after dedupe + suppression). */
    added: integer("added").notNull().default(0),
    minScore: integer("min_score").notNull().default(50),
    status: text("status", { enum: ["running", "done", "failed"] }).notNull().default("running"),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("discovery_runs_account_idx").on(t.accountId, t.createdAt)]
);

/* A background discovery job for large/"unlimited" sweeps. The provider is hit
   ONCE up front and every candidate is staged in `candidates` (jsonb); a worker
   then enriches + scores them in small batches across many invocations, so a
   thousand-business sweep never blocks a request or hits a serverless timeout.
   `processed` is the cursor into `candidates`. */
export const discoveryJobs = pgTable(
  "discovery_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => discoveryRuns.id, { onDelete: "set null" }),
    provider: text("provider", { enum: ["places", "osm", "sample"] }).notNull(),
    vertical: text("vertical").notNull(),
    location: text("location").notNull(),
    radiusMiles: integer("radius_miles").notNull().default(25),
    minScore: integer("min_score").notNull().default(50),
    /** queued → staging (fetching candidates) → enriching → done/failed. */
    status: text("status", { enum: ["queued", "staging", "enriching", "done", "failed"] })
      .notNull()
      .default("queued"),
    /** All raw candidates from the provider, staged up front. */
    candidates: jsonb("candidates").$type<unknown[]>().notNull().default([]),
    total: integer("total").notNull().default(0),
    /** Cursor: how many candidates have been enriched + scored so far. */
    processed: integer("processed").notNull().default(0),
    qualified: integer("qualified").notNull().default(0),
    added: integer("added").notNull().default(0),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("discovery_jobs_account_idx").on(t.accountId, t.status, t.createdAt)]
);

/** Every machine-checkable observation behind a lead's score. `kind` groups it
    into the rubric's three axes so the UI can explain "why this lead". */
export type Evidence = {
  kind: "income" | "web" | "marketing";
  /** "stable" = a reason to pitch (income stability); "gap" = a fixable weakness. */
  polarity: "stable" | "gap";
  label: string;
  detail: string;
  /** Points this observation contributed to its axis sub-score. */
  weight: number;
};

/** Deterministic enrichment output for one business. Everything degrades to a
    safe default so an unreachable site never crashes the pipeline. */
export type LeadSignals = {
  fetched: boolean;
  reachable: boolean;
  hasWebsite: boolean;
  https: boolean;
  /** viewport meta present — a coarse but reliable "built for mobile" proxy. */
  mobileFriendly: boolean | null;
  /** Detected site builder/host: "wix" | "godaddy" | "squarespace" | "wordpress"
      | "weebly" | "parking" | null. */
  builder: string | null;
  /** Parked domain / "coming soon" / "under construction" placeholder. */
  parking: boolean;
  copyrightYear: number | null;
  staleCopyright: boolean;
  hasContactForm: boolean | null;
  hasBooking: boolean | null;
  hasEmailCapture: boolean | null;
  pageBytes: number | null;
  /** Fetch took a long time OR payload is heavy — a rough performance flag. */
  slow: boolean | null;
  /** Business-stability + marketing signals, mostly from the discovery provider. */
  rating: number | null;
  reviewCount: number | null;
  ageYears: number | null;
  socials: { facebook?: boolean; instagram?: boolean; linkedin?: boolean; yelp?: boolean };
  /** A contact email scraped from the site, if any (mailto/visible). */
  emailFound: string | null;
};

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => discoveryRuns.id, { onDelete: "set null" }),

    businessName: text("business_name").notNull(),
    vertical: text("vertical").notNull().default("generic"),
    website: text("website").notNull().default(""),
    /** Best contact email we have. May be "" — then the lead is review-only. */
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    /** The owner's first name — never available from Places/OSM, so the owner fills
        it in (or learns it on the call). When set, the email greets "Hi {name},". */
    contactFirstName: text("contact_first_name").notNull().default(""),
    /** Source of the owner name once set: "parsed" (from the business name),
        "ai" (AI read the About/Team page), "website" (regex About-page scrape),
        "manual"/"bulk" (you typed/pasted it). */
    contactSource: text("contact_source").notNull().default(""),
    /** Why we believe this name — the exact sentence the owner was found in (AI /
        website sources) or how it was derived. Shown in the UI so every name is
        verifiable, never a bare assertion. Empty for hand-entered names. */
    contactEvidence: text("contact_evidence").notNull().default(""),
    /** True once the auto owner-finder has attempted this lead (found or not), so
        the background worker knows what's left and never re-scrapes endlessly. */
    ownerTried: boolean("owner_tried").notNull().default(false),
    address: text("address").notNull().default(""),
    location: text("location").notNull().default(""),
    mapsUrl: text("maps_url").notNull().default(""),
    source: text("source").notNull().default(""),

    signals: jsonb("signals").$type<LeadSignals | null>(),
    evidence: jsonb("evidence").$type<Evidence[]>().notNull().default([]),

    incomeScore: integer("income_score").notNull().default(0),
    needScore: integer("need_score").notNull().default(0),
    /** 0–100 opportunity score: stable income × fixable digital gap. */
    score: integer("score").notNull().default(0),
    primaryGap: text("primary_gap", { enum: ["web", "marketing", "both", "none"] })
      .notNull()
      .default("none"),

    draftSubject: text("draft_subject").notNull().default(""),
    draftBody: text("draft_body").notNull().default(""),
    /** True once the owner hand-edits the draft. Auto-drafts (false) are
        regenerated when the sender profile changes so they read as the owner;
        edited drafts are left untouched. */
    draftEdited: boolean("draft_edited").notNull().default(false),

    /* discovered → drafted → queued (awaiting human OK) → sent → replied/won/lost.
       skipped = human dismissed; suppressed = on the unsubscribe list. */
    status: text("status", {
      enum: ["discovered", "drafted", "queued", "sent", "skipped", "suppressed", "replied", "won", "lost"],
    })
      .notNull()
      .default("discovered"),

    /** Stable key for dedupe across runs — normalized domain, else name+location. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Emails sent in this lead's thread so far (0 = none, 1 = opener sent, …).
        Doubles as the next ordinal to send. */
    step: integer("step").notNull().default(0),
    /** When the next follow-up is due. Null = no follow-up pending (not yet sent,
        sequence finished, or follow-ups off). */
    nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
    lastTouchAt: timestamp("last_touch_at", { withTimezone: true }),

    /* Email deliverability verification (catch-all / bounce guard). A discovered
       email is only auto-sendable once it verifies "valid"; "accept_all"
       (catch-all domain — can't be confirmed) is held for human review;
       "invalid"/"disposable" are never sent. Protects the owner's own mailbox
       reputation from hard bounces. */
    verifyStatus: text("verify_status", {
      enum: ["unverified", "valid", "invalid", "accept_all", "disposable", "unknown"],
    })
      .notNull()
      .default("unverified"),
    verifyScore: integer("verify_score"),
    verifyProvider: text("verify_provider"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    /* The connected-mailbox thread id of the outreach (Gmail threadId), so an
       inbound reply on that thread can be matched back to this lead and auto-stop
       the sequence. Null until sent via a connected mailbox. */
    providerThreadId: text("provider_thread_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* One business per account, ever — re-running discovery never duplicates or
       re-pitches a lead you've already seen. */
    uniqueIndex("leads_account_dedupe_unique").on(t.accountId, t.dedupeKey),
    index("leads_account_status_idx").on(t.accountId, t.status, t.score),
    index("leads_thread_idx").on(t.accountId, t.providerThreadId),
  ]
);

/* A connected sending mailbox (Gmail today, Outlook later). Cold email from the
   owner's REAL mailbox gets the best inbox placement, and — because we can read
   the thread's metadata — lets us auto-detect replies and stop the sequence with
   no manual "mark replied". Tokens are AES-256-GCM encrypted at rest. "mock" is
   the zero-key dev provider: it sends to the dev outbox and supports simulated
   replies, so the whole connect→send→reply loop is testable with no Google app. */
export const mailboxConnections = pgTable(
  "mailbox_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["gmail", "mock"] }).notNull(),
    /** The connected mailbox address — what outreach sends "from". */
    email: text("email").notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    grantedScopes: text("granted_scopes").notNull().default(""),
    status: text("status", { enum: ["connected", "reauth_required", "disabled"] })
      .notNull()
      .default("connected"),
    /** Gmail historyId watermark for incremental reply polling. */
    historyId: text("history_id"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    /** Per-mailbox warm-up clock (cold sending ramps per mailbox, not per account). */
    warmupStartedAt: timestamp("warmup_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("mailbox_account_email_unique").on(t.accountId, t.email)]
);

/* The idempotency backstop + daily-cap ledger. unique(leadId, ordinal) makes any
   single step (opener = 0, follow-ups = 1,2,…) physically un-sendable twice even
   if the dispatcher double-fires. accountId is denormalized so the daily-cap query
   is one indexed count across every step. */
export const leadSends = pgTable(
  "lead_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Which step in the thread: 0 = opener, 1 = first follow-up, 2 = final note. */
    ordinal: integer("ordinal").notNull().default(0),
    /** "auto" = dispatcher (hybrid mode), "manual" = human clicked send. */
    mode: text("mode", { enum: ["auto", "manual"] }).notNull(),
    ok: boolean("ok").notNull().default(false),
    detail: text("detail"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lead_send_step_unique").on(t.leadId, t.ordinal),
    index("lead_sends_cap_idx").on(t.accountId, t.sentAt),
  ]
);

export const outboxEmails = pgTable(
  "outbox_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id"),
    toAddr: text("to_addr").notNull(),
    fromAddr: text("from_addr").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    kind: text("kind", { enum: ["magic-link", "verify", "outreach", "reply", "test"] }).notNull(),
    sentVia: text("sent_via", { enum: ["resend", "dev-outbox"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("outbox_account_idx").on(t.accountId, t.createdAt)]
);

/* Addresses the account may use as reply-to. The login email is auto-verified at
   account creation; any other address needs a click-to-confirm before we use it. */
export const verifiedAddresses = pgTable(
  "verified_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    verified: boolean("verified").notNull().default(false),
    verifyTokenHash: text("verify_token_hash"),
    verifyExpiresAt: timestamp("verify_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("verified_addr_unique").on(t.accountId, t.email)]
);

/* Per-account global suppression — an unsubscribe applies across every lead that
   account ever contacts, forever. Checked at discovery AND at send time. */
export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    reason: text("reason").notNull().default("unsubscribed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suppression_unique").on(t.accountId, t.email)]
);
