# ScoutNet — outbound cold email for solo and local businesses

The outbound sibling of LeadNet. LeadNet catches the people who come to you;
ScoutNet starts the conversations yourself. Same architecture, same zero-env dev
experience, same "honest by design" stance — applied to cold outreach.

## Product decisions (locked with owner, 2026-06-12)

- **Audience: imported prospects (cold outreach).** Owner uploads a CSV of business
  contacts (or adds them manually) and runs multi-step outreach sequences.
- **Separate app** at `~/claude code/scoutnet`, its own dashboard, mirroring LeadNet's
  stack: Next.js 16.2.9 / React 19.2.4 / Tailwind v4 / Drizzle / PGlite dev / Postgres prod.
- **Sending: owner's own Resend key + verified domain only.** Cold email never goes
  through a shared platform domain. In dev (no key) everything lands in the dev outbox.
- **Full feature set**: campaign sequence builder, pipeline inbox, Outbound Advisor,
  AI-drafted per-vertical copy (deterministic, no LLM key required — like LeadNet's
  site analyzer).

## Design system (ui-ux-pro-max)

- Sibling identity to LeadNet's emerald: **navy/slate + sky CTA**.
  - Primary `#0F172A` (slate-900), secondary `#334155` (slate-700),
    CTA `#0369A1` (sky-700), background `#F8FAFC` (slate-50), text `#020617`.
  - Accent tint usage mirrors LeadNet's emerald-50/emerald-900 pattern → sky-50/sky-900.
- Font: **Plus Jakarta Sans** (300–700) via next/font, headings and body.
- Style: "sales intelligence dashboard" — clean, light-mode, data-forward. No emoji
  icons (inline SVG, Lucide-style 24×24 viewBox), cursor-pointer + 150–300ms color
  transitions on interactive elements, visible focus rings, 4.5:1 contrast minimum,
  prefers-reduced-motion respected. No dark-mode default, no excessive animation.

## Core flows

1. **Magic-link sign-in** — identical mechanics to LeadNet (hashed tokens, session
   cookie, dev mode surfaces the link on the page).
2. **Onboarding** — give your email + your website; the deterministic site analyzer
   extracts business name / phone / postal address / trade / accent color, provenance-
   tagged and editable. Output: a configured sender identity + a suggested campaign
   template for the detected vertical.
3. **Sender setup (Settings)** — owner pastes their own Resend API key and chooses a
   from address on their own verified domain. Key AES-256-GCM encrypted at rest with
   APP_SECRET. Postal address required before anything can send (CAN-SPAM).
   Reply-to defaults to the owner's verified login address.
4. **Prospects** — CSV import with column mapping preview + manual add. Dedup by
   email per account. Role-address warning (info@/sales@). Import requires an explicit
   affirmation checkbox: "These are business contacts I have a lawful basis to email."
   Suppressed addresses are skipped at import and at send.
5. **Campaigns** — name + vertical template + sequence of steps (step 1 immediately
   on enrollment-due date, follow-ups at day offsets). Merge fields:
   {{firstName}}, {{lastName}}, {{company}}, {{myBusiness}}, {{myName}}, {{myPhone}}.
   Pre-written cold outreach copy per vertical (realtor, contractor, attorney, salon,
   generic), editable in the dashboard sequence editor. Enrollment per prospect.
   The sequence **stops permanently** when a prospect is marked replied / won / lost,
   or unsubscribes.
6. **Sending engine** — cron dispatcher (`/api/cron/dispatch`, CRON_SECRET-protected,
   `vercel.json` schedule) with LeadNet's idempotent claim mechanics: a unique
   (enrollment, step) send row is claimed before sending so a double-fired cron can
   never double-send. Outbound extras:
   - **Daily send cap** per account (default 30/day, max 200) with a warm-up ramp
     suggestion in the Advisor.
   - Suppression checked at send time; CAN-SPAM footer (postal address + one-click
     unsubscribe signed token) appended to every email, non-removable.
   - Dev mode: "Run dispatch" button + due-date fast-forward, mails land in dev outbox.
7. **Pipeline inbox** — per-prospect status flow `queued → sent → replied → won/lost`,
   with a follow-up timer (time since last touch). Marking "replied" stops the
   sequence and moves the prospect into a worked state — mirror of LeadNet's
   speed-to-lead inbox semantics. No tracking pixels: honest by design; reply state
   is owner-marked (replies arrive in the owner's real inbox via reply-to).
8. **Outbound Advisor** — deterministic, always-on panel; reads real account numbers
   and returns the single most valuable next action, priority-ordered, e.g.:
   connect your sending domain → add postal address → import prospects → activate a
   campaign → follow up with N repliers → daily cap hit M days running (raise it) →
   campaign X has 0 replies after 50+ sends (rewrite the opener) → idle prospects
   never enrolled.
9. **AI-drafted copy** — "Draft for me": deterministic personalization engine
   (no LLM, no API key) that composes outreach copy from the analyzed business
   details + vertical + prospect merge fields, with a few selectable angles
   (introduction / social proof / direct ask).
10. **Landing page** — marketing page at `/` with LeadNet-quality copy, navy/sky
    design: hero, how-it-works, deliverability/compliance trust section, verticals,
    honest-by-design section, CTA. Plus `/robots.ts`, `/sitemap.ts`, `/api/health`.

## Honest by design — outbound edition (non-negotiable)

- Every email carries the owner's real postal address and a working one-click
  unsubscribe (stateless signed token → per-account suppression, checked at send).
- No sending without: verified own-domain sender, postal address, lawful-basis
  affirmation on the imported list.
- Hard daily caps; the dispatcher enforces them, not just the UI.
- No open-tracking pixels, no deceptive "RE:/FW:" subjects (Advisor flags them).
- Suppression is permanent and account-wide; re-importing a suppressed address is a no-op.
- The dispatcher is idempotent (unique claim row per enrollment+step).

## Zero-env dev (must work with `npm install && npm run dev`)

- PGlite embedded Postgres in `.data/`, migrations auto-applied.
- Dev outbox at `/dashboard/outbox`; sign-in page surfaces the magic link.
- Full loop testable offline: sign up → onboard → import CSV → create campaign →
  enroll → run dispatch → see sends in outbox → mark replied → advisor updates.
