# ScoutNet — find the businesses that need you

Built by **[Nicholas Nyaung](https://nicholasnyaung.com)**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
&nbsp;![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs&logoColor=white)
&nbsp;![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
&nbsp;![Runs with zero config](https://img.shields.io/badge/setup-zero%20config-brightgreen)

A lead-discovery + qualification + outreach agent for web designers, marketers,
and agencies. The third sibling in the -Net family:
[LeadNet](../leadnet) **catches** inbound leads, [ReachNet](../reachnet) **sends**
to lists you bring, and **ScoutNet finds** the list in the first place.

ScoutNet searches the web for stable, money-making local businesses whose website
or marketing is quietly costing them customers, scores each one on the evidence,
drafts an honest pitch, and sends it from your own domain — **auto-send for the
strongest matches, your review queue for the rest** (hybrid mode).

## The idea

The hard part of "find businesses with stable income whose marketing is crumbling"
is making that fuzzy brief *machine-checkable*. ScoutNet operationalizes it into
two scored axes with transparent evidence behind every point:

- **Income / stability** (is this worth your time?) — recession-resistant trade,
  review count and longevity, solid rating. Steady money you can see.
- **Digital gap** (can you fix it?) — split into a **web** axis (no site, parked
  page, no SSL, not mobile, stale copyright, DIY builder, no contact form) and a
  **marketing** axis (thin/declining reviews, soft rating, no socials, no email
  capture, no online booking).

`opportunity = need, scaled by income stability` — so a 14-year, 200-review shop
with a broken 2016 website outranks a flashy startup with no track record.

## Pipeline

`discover → enrich → score → draft → (auto-send | review) → track`

1. **Discover** — three interchangeable providers (newest-data-first):
   - **Google Places** (real, richest data) — set `GOOGLE_PLACES_API_KEY`.
   - **OpenStreetMap** (real, free, no key) — Nominatim geocode + Overpass.
   - **Sample** (deterministic demo) — fake businesses to test the whole loop offline.
2. **Enrich** — fetches each business's site (SSRF-guarded, redirects re-validated)
   and reads SSL, mobile-readiness, builder, parked pages, stale copyright,
   contact/booking/email-capture, page weight, socials, and a contact email.
3. **Score** — the rubric above; every point maps to an `Evidence` row the UI shows.
4. **Draft** — a short, honest cold email built from the *same evidence* — no
   invented flattery. You edit any word before it sends.
5. **Send** — **hybrid**: leads ≥ your `autoSendThreshold` auto-send; everything
   below waits in the review queue. Idempotent, daily-capped, warm-up ramped.
6. **Track** — one cold approach per business ever; replies/opt-outs stop everything.

## Honest & compliant by design

- Cold email leaves only through **your own Resend key + verified domain** — there
  is no shared ScoutNet sending domain.
- Every email carries your **postal address** and a **one-click List-Unsubscribe**
  (RFC 8058); an unsubscribe suppresses the address **forever**, checked at both
  discovery and send time.
- A hard **daily cap** + **warm-up ramp** the dispatcher enforces (not just the UI).
- Sender API keys are **AES-256-GCM encrypted at rest**; unsubscribe links are
  stateless signed tokens.

## Quickstart (zero config)

```bash
npm install
npm run dev        # http://localhost:3000
```

With no `.env` at all: embedded Postgres (PGlite in `.data/`), discovery runs on
free OpenStreetMap + sample data, and outreach lands in the in-app **Outbox**
(`/dashboard/outbox`) instead of real inboxes. Sign in with the dev magic link,
fill Settings, run a search, and walk the full loop without sending a real email.

To go live: copy `.env.example` → `.env.local`, set `APP_SECRET` + `DATABASE_URL`,
add your Resend key + verified domain in **Settings**, and (optionally)
`GOOGLE_PLACES_API_KEY` for the richest discovery data.

## Deploy your own

One click — ScoutNet runs on a single Vercel project plus a serverless Postgres:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/nyaungnicholas-wq/scoutnet&env=APP_SECRET,DATABASE_URL&envDescription=APP_SECRET%20encrypts%20stored%20sender%20keys%3B%20DATABASE_URL%20is%20a%20serverless%20Postgres%20(e.g.%20Neon)&envLink=https://github.com/nyaungnicholas-wq/scoutnet/blob/main/.env.example)

Vercel prompts for the two required secrets. Generate `APP_SECRET` with
`openssl rand -base64 32`, and create a free Postgres at [Neon](https://neon.tech)
for `DATABASE_URL`. Everything else (`GOOGLE_PLACES_API_KEY`, Resend, Gmail OAuth,
cron) is optional and documented in [`.env.example`](.env.example). Migrations run
automatically on first boot. Prefer local first? See **Quickstart** above.

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind v4 · Drizzle ORM · PGlite/Postgres.
Forked from ReachNet's infrastructure (auth, encrypted sender keys, dev outbox,
suppression, deliverability, unsubscribe, dispatcher) with a fresh discovery brain
(`lib/agent/*`, `lib/dispatch.ts`) on top.
