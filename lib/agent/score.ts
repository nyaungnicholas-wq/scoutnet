import type { Evidence, LeadSignals } from "@/db/schema";
import { getVertical } from "@/lib/verticals";

/* The qualification brain. Turns enrichment signals into three transparent
   numbers + the evidence behind them:

     incomeScore — is this a STABLE business worth pitching? (longevity, steady
                   review flow, recession-resistant trade)
     needScore   — does it have a FIXABLE digital gap? (web problems + marketing
                   problems, the deeper the gap the higher)
     score       — the opportunity: needScore scaled by income stability, so the
                   top of the list is "steady money AND clearly needs help".

   Everything is deterministic and explainable — each point maps to an Evidence
   row the UI can show, because "trust me, 84" is not a pitch you can act on. */

export type ScoreResult = {
  incomeScore: number;
  needScore: number;
  score: number;
  primaryGap: "web" | "marketing" | "both" | "none";
  evidence: Evidence[];
};

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function scoreLead(verticalKey: string, s: LeadSignals): ScoreResult {
  const vertical = getVertical(verticalKey);
  const evidence: Evidence[] = [];

  /* ---- income / stability (is this worth your time?) -------------------- */
  let income = 0;

  const priorPts = Math.round(vertical.incomePrior * 38);
  income += priorPts;
  evidence.push({
    kind: "income",
    polarity: "stable",
    label: `${vertical.label}`,
    detail: vertical.incomePrior >= 0.85 ? "Recession-resistant trade with steady, recurring demand." : "Local trade with reasonably steady demand.",
    weight: priorPts,
  });

  const hasMarketData = s.reviewCount != null || s.ageYears != null;

  if (s.reviewCount != null) {
    const pts = Math.round((Math.min(s.reviewCount, 300) / 300) * 34);
    income += pts;
    evidence.push({
      kind: "income",
      polarity: "stable",
      label: `${s.reviewCount} reviews`,
      detail: s.reviewCount >= 100 ? "A long, steady stream of customers — a real, durable business." : s.reviewCount >= 25 ? "An established customer base." : "A modest review history.",
      weight: pts,
    });
  }

  if (s.ageYears != null) {
    const pts = Math.round((Math.min(s.ageYears, 20) / 20) * 16);
    income += pts;
    evidence.push({ kind: "income", polarity: "stable", label: `~${s.ageYears} years in business`, detail: "Longevity is the cheapest proxy for stable revenue.", weight: pts });
  }

  if (s.rating != null && s.rating >= 4.0) {
    income += 10;
    evidence.push({ kind: "income", polarity: "stable", label: `${s.rating.toFixed(1)}★ rating`, detail: "Customers are satisfied — the income is healthy, the digital presence is the gap.", weight: 10 });
  } else if (s.rating != null && s.rating < 4.0) {
    evidence.push({ kind: "income", polarity: "stable", label: `${s.rating.toFixed(1)}★ rating`, detail: "Rating is soft — reputation work could be part of the pitch.", weight: 0 });
  }

  /* No provider market data (common with the free OSM source): fall back to the
     trade's prior alone and say so, rather than inventing confidence. */
  if (!hasMarketData) {
    income = Math.round(vertical.incomePrior * 68);
    evidence.push({ kind: "income", polarity: "stable", label: "Limited public data", detail: "No review/age data from this source — stability estimated from the trade alone.", weight: 0 });
  }

  const incomeScore = clamp(income);

  /* ---- web gap (does it need a website / a better one?) ---------------- */
  let webNeed = 0;
  const web = (label: string, detail: string, weight: number) => {
    webNeed += weight;
    evidence.push({ kind: "web", polarity: "gap", label, detail, weight });
  };

  if (!s.hasWebsite) {
    web("No website found", "Stable demand with no website at all — the single biggest, clearest gap to close.", 88);
  } else if (s.parking) {
    web("Parked / placeholder page", "The domain resolves to a 'coming soon' or parked page — effectively no website.", 80);
  } else if (s.hasWebsite && !s.reachable) {
    web("Website won't load", "There's a site on record but it failed to load — broken or down sites bleed customers daily.", 55);
  } else {
    if (!s.https) web("No SSL (http only)", "Browsers flag the site 'Not secure' — it scares off visitors and hurts SEO.", 30);
    if (s.mobileFriendly === false) web("Not mobile-friendly", "No mobile viewport — most local searches are on phones, and the site breaks on them.", 28);
    if (s.staleCopyright && s.copyrightYear) web(`Copyright stuck at ${s.copyrightYear}`, "A stale footer year signals the site (and the business?) has been left untended.", 18);
    if (s.builder && ["wix", "godaddy", "weebly"].includes(s.builder)) web(`DIY ${s.builder} site`, "A drag-and-drop template — fine to start, but usually slow, generic, and capped on SEO.", 12);
    if (s.hasContactForm === false) web("No contact form", "No quick way to capture a lead — visitors who don't call are simply lost.", 16);
    if (s.slow) web("Slow / heavy page", "Slow load times push visitors away and sink search ranking.", 10);
  }

  /* ---- marketing gap (is the marketing crumbling?) -------------------- */
  let mktNeed = 0;
  const mkt = (label: string, detail: string, weight: number) => {
    mktNeed += weight;
    evidence.push({ kind: "marketing", polarity: "gap", label, detail, weight });
  };

  // Low reviews despite an otherwise stable business = under-marketed reputation.
  if (s.reviewCount != null && s.reviewCount < 25 && incomeScore >= 40) {
    mkt("Thin review presence", `Only ${s.reviewCount} reviews for an established business — reputation marketing is being left on the table.`, 38);
  }
  if (s.rating != null && s.rating < 4.0) {
    mkt(`${s.rating.toFixed(1)}★ rating`, "A soft public rating that review-generation and response could lift.", 20);
  }
  const socialCount = Object.values(s.socials).filter(Boolean).length;
  if (s.fetched && s.reachable && socialCount === 0) {
    mkt("No social links", "No Facebook/Instagram/LinkedIn linked from the site — invisible on the channels locals browse.", 24);
  }
  if (s.hasEmailCapture === false && s.reachable) {
    mkt("No email capture", "No newsletter or list signup — every visitor leaves without becoming a contact to remarket to.", 14);
  }
  if (s.hasBooking === false && s.reachable) {
    mkt("No online booking", "No way to book/quote online — friction that quietly sends customers to competitors.", 10);
  }

  const webScore = Math.min(100, webNeed);
  const mktScore = Math.min(100, mktNeed);
  // Weak in both axes should outrank weak in one — reward the union.
  const needScore = clamp(Math.max(webScore, mktScore) + 0.4 * Math.min(webScore, mktScore));

  /* primary gap — which problem leads the pitch. */
  let primaryGap: ScoreResult["primaryGap"];
  if (webScore < 12 && mktScore < 12) primaryGap = "none";
  else if (webScore >= 25 && mktScore >= 25) primaryGap = "both";
  else if (webScore >= mktScore + 8) primaryGap = "web";
  else if (mktScore >= webScore + 8) primaryGap = "marketing";
  else primaryGap = "both";

  /* opportunity = need, scaled by how stable/worth-it the business is. A glaring
     gap at a business we can't confirm is real gets discounted; the same gap at a
     14-year, 200-review shop rises to the top. The floor of 0.6 keeps a clear,
     fixable gap from being buried just because provider data on the business is
     thin — the need is real either way. */
  const stability = incomeScore / 100;
  const score = clamp(needScore * (0.6 + 0.4 * stability));

  return { incomeScore, needScore, score, primaryGap, evidence };
}

/** Stable dedupe key: the registrable-ish domain when there's a site, else a
    slug of name + location. Keeps re-runs from duplicating or re-pitching. */
export function dedupeKey(website: string, businessName: string, location: string): string {
  const w = website.trim().toLowerCase();
  if (w) {
    try {
      const host = new URL(/^https?:\/\//.test(w) ? w : `https://${w}`).hostname.replace(/^www\./, "");
      if (host) return `site:${host}`;
    } catch {
      /* fall through to name slug */
    }
  }
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `name:${slug(businessName)}|${slug(location.split(",")[0] ?? "")}`;
}
