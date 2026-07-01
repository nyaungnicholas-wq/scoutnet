import type { LeadSignals } from "@/db/schema";
import { validateUrl } from "@/lib/ssrf";
import type { RawCandidate } from "@/lib/agent/discovery";

/* Deterministic website enrichment — no LLM. Fetches a candidate's public site
   (SSRF-guarded, redirects re-validated per hop) and reads the handful of signals
   that separate "needs a website / crumbling marketing" from "already dialled in":
   SSL, mobile-readiness, site builder, parked pages, stale copyright, contact/
   booking/email-capture presence, page weight, socials, and a contact email.
   Every field degrades to a safe default so an unreachable site never crashes the
   pipeline — being unreachable is itself a strong signal. */

const MAX_BYTES = 512 * 1024;
const SLOW_MS = 4_000;
const HEAVY_BYTES = 1_500_000;

type Provided = { rating: number | null; reviewCount: number | null; ageYears: number | null };

function emptySignals(provided: Provided): LeadSignals {
  return {
    fetched: false,
    reachable: false,
    hasWebsite: false,
    https: false,
    mobileFriendly: null,
    builder: null,
    parking: false,
    copyrightYear: null,
    staleCopyright: false,
    hasContactForm: null,
    hasBooking: null,
    hasEmailCapture: null,
    pageBytes: null,
    slow: null,
    rating: provided.rating,
    reviewCount: provided.reviewCount,
    ageYears: provided.ageYears,
    socials: {},
    emailFound: null,
  };
}

export async function enrich(candidate: RawCandidate): Promise<LeadSignals> {
  // Sample provider ships pre-baked signals — no point fetching a fake domain.
  if (candidate.demoSignals) return candidate.demoSignals;

  const provided: Provided = {
    rating: candidate.rating,
    reviewCount: candidate.reviewCount,
    ageYears: candidate.ageYears,
  };

  const raw = candidate.website.trim();
  if (!raw) return emptySignals(provided); // hasWebsite:false, reachable:false

  let normalized = raw;
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  const httpScheme = /^http:\/\//i.test(normalized);

  const checked = validateUrl(normalized.replace(/^http:\/\//i, "https://"));
  if (!checked.ok) {
    // Has a website on record but we can't safely fetch it.
    return { ...emptySignals(provided), hasWebsite: true };
  }

  const started = Date.now();
  let html = "";
  let finalUrl = checked.url;
  let reachable = false;
  try {
    let current = checked.url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "ScoutNetBot/1.0", Accept: "text/html" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        // Upgrade http→https on redirects too (matches the initial-URL handling),
        // so an https→http redirect doesn't get dropped by the https-only guard.
        const next = validateUrl(new URL(loc, current).href.replace(/^http:\/\//i, "https://"));
        if (!next.ok) break;
        current = next.url;
        finalUrl = next.url;
        continue;
      }
      break;
    }
    if (res && res.ok) {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("html") || ct.includes("text")) {
        const buf = await res.arrayBuffer();
        html = Buffer.from(buf.slice(0, MAX_BYTES)).toString("utf8");
        reachable = true;
      } else {
        reachable = true; // responded, just not HTML
      }
    }
  } catch {
    reachable = false;
  }
  const elapsed = Date.now() - started;

  if (!reachable) {
    return { ...emptySignals(provided), hasWebsite: true, fetched: true };
  }

  const lower = html.toLowerCase();
  const bytes = Buffer.byteLength(html, "utf8");

  return {
    fetched: true,
    reachable: true,
    hasWebsite: true,
    https: finalUrl.startsWith("https://") && !httpScheme,
    mobileFriendly: /<meta[^>]+name=["']viewport["']/i.test(html),
    builder: detectBuilder(lower),
    parking: detectParking(lower, bytes),
    copyrightYear: detectCopyrightYear(html),
    staleCopyright: isStale(detectCopyrightYear(html)),
    hasContactForm: /<form/i.test(html) || /(contact\s*us|get\s*a\s*quote|free\s*estimate)/i.test(lower),
    hasBooking: /(book\s*now|book\s*online|schedule\s*(an\s*)?appointment|calendly\.com|acuityscheduling|squareup\.com\/appointments)/i.test(lower),
    hasEmailCapture: /(newsletter|subscribe|mailchimp|klaviyo|list-manage\.com|join\s*our\s*(email|mailing))/i.test(lower),
    pageBytes: bytes,
    slow: elapsed > SLOW_MS || bytes > HEAVY_BYTES,
    rating: provided.rating,
    reviewCount: provided.reviewCount,
    ageYears: provided.ageYears,
    socials: {
      facebook: /facebook\.com\//i.test(html),
      instagram: /instagram\.com\//i.test(html),
      linkedin: /linkedin\.com\//i.test(html),
      yelp: /yelp\.com\//i.test(html),
    },
    emailFound: findEmail(html),
  };
}

function detectBuilder(lower: string): string | null {
  if (lower.includes("wix.com") || lower.includes("_wixcss") || lower.includes("wix-warmup")) return "wix";
  if (lower.includes("squarespace")) return "squarespace";
  if (lower.includes("weebly")) return "weebly";
  if (lower.includes("godaddy") || lower.includes("websitebuilder.godaddy")) return "godaddy";
  if (lower.includes("wp-content") || lower.includes("wp-includes") || lower.includes("wordpress")) return "wordpress";
  return null;
}

function detectParking(lower: string, bytes: number): boolean {
  const phrases = ["coming soon", "under construction", "website is coming", "this domain is parked", "domain for sale", "buy this domain", "future home of", "account suspended"];
  if (phrases.some((p) => lower.includes(p))) return true;
  // A near-empty body on a live domain is almost always a placeholder.
  return bytes < 1200;
}

function detectCopyrightYear(html: string): number | null {
  const years: number[] = [];
  const re = /(?:©|&copy;|copyright)\s*(?:\d{4}\s*[–-]\s*)?(\d{4})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const y = Number(m[1]);
    if (y >= 1995 && y <= 2100) years.push(y);
  }
  return years.length ? Math.max(...years) : null;
}

function isStale(year: number | null): boolean {
  if (!year) return false;
  return year < new Date().getFullYear() - 1;
}

function findEmail(html: string): string | null {
  const mailto = html.match(/mailto:([^"'?>\s]+@[^"'?>\s]+\.[a-z]{2,})/i);
  if (mailto) return mailto[1].toLowerCase().slice(0, 160);
  const visible = html
    .replace(/<[^>]+>/g, " ")
    .match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  // Skip asset-ish false positives (e.g. someone@2x.png handled by the TLD check).
  if (visible && !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(visible[0])) return visible[0].toLowerCase().slice(0, 160);
  return null;
}
