import { validateUrl } from "@/lib/ssrf";
import { extractOwnerWithAI } from "@/lib/owner-ai";

/* Best-effort owner-name finder. No paid data provider reliably maps a corner
   local business to its owner's name — but the business's OWN website usually
   names them ("Owner, Mike Brennan" / "Meet Dana" / "founded by …"). So we fetch
   the homepage + a few common "about/team/contact" pages (SSRF-guarded) and read
   the owner out of them — AI first (precise, evidence-backed), then a structured
   JSON-LD/meta/regex fallback. Returns a SUGGESTION for the owner to confirm —
   never authoritative. Only works when the lead has a website. */

const MAX_BYTES = 400 * 1024;
const PATHS = [
  "",
  "/about",
  "/about-us",
  "/our-team",
  "/meet-the-team",
  "/team",
  "/staff",
  "/our-story",
  "/owner",
  "/contact",
];

const STOPWORDS = new Set([
  "the", "our", "about", "welcome", "home", "contact", "team", "us", "we", "service", "services",
  "heating", "cooling", "air", "company", "family", "owned", "operated", "quality", "best", "your",
  "google", "facebook", "yelp", "better", "business",
]);

/* Patterns that tie a Proper Name to an ownership role, both orders. */
const PATTERNS: RegExp[] = [
  /\b(?:owner|founder|co-?founder|proprietor|president|principal)(?:\s+(?:and|&)\s+\w+)?[\s,:—-]+(?:is\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,2})/,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,2})[\s,]+(?:is\s+)?(?:the\s+|our\s+|a\s+)?(?:owner|founder|co-?founder|proprietor|president)\b/,
  /\b(?:founded|established|started|owned|run|operated)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,2})/i,
  /\bmeet\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+)?)\b/i,
];

export type OwnerSource = "ai" | "website" | "parsed";
export type OwnerGuess = {
  firstName: string;
  fullName: string;
  context: string;
  sourceUrl: string;
  source: OwnerSource;
  confidence: "high" | "medium" | "low";
};

async function fetchText(url: string): Promise<string> {
  const checked = validateUrl(url.replace(/^http:\/\//i, "https://"));
  if (!checked.ok) return "";
  try {
    const res = await fetch(checked.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "ScoutNetBot/1.0", Accept: "text/html" },
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html") && !ct.includes("text")) return "";
    const buf = await res.arrayBuffer();
    return Buffer.from(buf.slice(0, MAX_BYTES)).toString("utf8");
  } catch {
    return "";
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

function plausibleName(name: string): boolean {
  const first = name.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first.length < 2 || STOPWORDS.has(first)) return false;
  // every token should look like a name token (letters, maybe an apostrophe/hyphen)
  return name.split(/\s+/).every((t) => /^[A-Z][a-z'.-]+$/.test(t));
}

/* CONSERVATIVE name-from-business parser. Only fires when the business name carries
   a professional CREDENTIAL ("Osorio Jorge, DDS" / "Albert S. Chang DDS" /
   "Raul Castellanos, Jr., D.D.S.") or a "Dr." prefix — there the name is
   unambiguously a person and the first name is reliable. For everything else
   (generic shops, "Man Dental Chino Hills", "Henry's Automotive") it returns null
   and lets the website scrape (or your researched paste list) handle it, because a
   wrong "Hi Man," is worse than a neutral "Hi,". Deterministic, free, no network. */
const CREDENTIAL = /\b(d\.?d\.?s|d\.?m\.?d|dds|dmd|m\.?d|cpa|esq)\b/i;
const STRIP = /\b(d\.?d\.?s|d\.?m\.?d|dds|dmd|md|cpa|esq|inc|llc|jr|sr|ii|iii|pc|apc)\b/gi;
const NOT_PERSON = new Set([
  ...STOPWORDS,
  "dental", "dentistry", "auto", "repair", "automotive", "service", "services", "tire", "tires",
  "smog", "check", "center", "shop", "garage", "body", "mechanic", "mechanical", "plumbing",
  "cafe", "bakery", "deli", "pizza", "market", "boutique", "studio", "group", "express", "club",
  "national", "professional", "complete", "budget", "comfort", "total", "window", "tint", "office",
]);

export function parseNameFromBusiness(businessName: string): OwnerGuess | null {
  const hasDr = /^\s*dr\.?\s+/i.test(businessName);
  if (!CREDENTIAL.test(businessName) && !hasDr) return null; // only confident on credentialed names

  const raw = businessName.replace(/^\s*dr\.?\s+/i, "").replace(STRIP, " ");
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => /^[A-Z][a-zA-Z'’.-]*$/.test(t) && t.length > 1 && !NOT_PERSON.has(t.toLowerCase()));
  if (tokens.length < 2) return null;

  // Directory "Surname Firstname, DDS" order ONLY when the credential follows
  // directly after exactly two words and a comma (e.g. "Osorio Jorge, DDS"), and
  // there's no Jr/Sr (which signals a normal "Firstname Lastname, Jr." order).
  const surnameFirst =
    /^[A-Za-z'’.-]+\s+[A-Za-z'’.-]+\s*,\s*(d\.?d\.?s|d\.?m\.?d|dds|dmd|md)\b/i.test(businessName) &&
    !/\b(jr|sr|ii|iii)\b/i.test(businessName);
  const first = surnameFirst ? tokens[1] : tokens[0];
  if (!first || NOT_PERSON.has(first.toLowerCase())) return null;
  return {
    firstName: first,
    fullName: tokens.join(" "),
    context: businessName,
    sourceUrl: "",
    source: "parsed",
    confidence: "high",
  };
}

/** Normalize a website value to an https origin, or null if unusable. */
function toOrigin(website: string): string | null {
  const base = website.trim();
  if (!base) return null;
  try {
    return new URL(/^https?:\/\//i.test(base) ? base : `https://${base}`).origin;
  } catch {
    return null;
  }
}

/** Fetch the homepage + a few about/team/contact pages, SSRF-guarded, returning
    both raw HTML (for JSON-LD/meta) and cleaned text (for AI + regex). Stops early
    once it has enough material so we don't hammer the site. Never throws. */
export async function fetchOwnerPages(
  website: string,
  maxPages = 5
): Promise<{ url: string; html: string; text: string }[]> {
  const origin = toOrigin(website);
  if (!origin) return [];
  const out: { url: string; html: string; text: string }[] = [];
  for (const p of PATHS) {
    if (out.length >= maxPages) break;
    const url = origin + p;
    const html = await fetchText(url);
    if (!html) continue;
    out.push({ url, html, text: htmlToText(html) });
  }
  return out;
}

/* Pull an owner name out of JSON-LD structured data — the most reliable on-page
   source when present. Looks for schema.org `founder`/`owner` (and a `Person`
   whose jobTitle reads owner/founder). */
function nameFromJsonLd(html: string): { fullName: string; role: string } | null {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const json = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      for (const key of ["founder", "owner"]) {
        const v = obj[key];
        const person = Array.isArray(v) ? v[0] : v;
        const name = typeof person === "string" ? person : (person as Record<string, unknown>)?.name;
        if (typeof name === "string" && /^[A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,2}$/.test(name.trim())) {
          return { fullName: name.trim(), role: key };
        }
      }
    }
  }
  return null;
}

/* Run the prose regex patterns over page text; returns the matched name + the
   surrounding sentence as evidence. */
function nameFromText(text: string): { fullName: string; context: string } | null {
  for (const re of PATTERNS) {
    const m = text.match(re);
    const candidate = m?.[1]?.trim();
    if (candidate && plausibleName(candidate)) {
      const at = text.indexOf(m![0]);
      const context = text.slice(Math.max(0, at - 30), at + m![0].length + 30).trim();
      return { fullName: candidate, context: context.slice(0, 160) };
    }
  }
  return null;
}

/** Structured (non-AI) owner extraction from fetched pages: JSON-LD first (high
    confidence), then the prose regex (low confidence). The free-engine fallback. */
function extractOwnerFree(pages: { url: string; html: string; text: string }[]): OwnerGuess | null {
  for (const page of pages) {
    const ld = nameFromJsonLd(page.html);
    if (ld) {
      return {
        firstName: ld.fullName.split(/\s+/)[0],
        fullName: ld.fullName,
        context: `Listed as ${ld.role} in the site's structured data.`,
        sourceUrl: page.url,
        source: "website",
        confidence: "high",
      };
    }
  }
  for (const page of pages) {
    const t = nameFromText(page.text);
    if (t) {
      return {
        firstName: t.fullName.split(/\s+/)[0],
        fullName: t.fullName,
        context: t.context,
        sourceUrl: page.url,
        source: "website",
        confidence: "low",
      };
    }
  }
  return null;
}

/** Auto owner-finder for the in-page poller and the 24/7 cron worker. Commits ONLY
    high-confidence sources so a wrong name can never silently personalize — and
    possibly auto-send — a greeting:
      1. the deterministic parse of a credentialed business name ("… DDS"), then
      2. AI reading the site's About/Team page (precise, evidence-backed).
    Everything else is left blank (a neutral "Hi,"). The looser JSON-LD/regex scrape
    is reserved for the MANUAL, owner-confirmed "Find on website" button below.
    Never throws. */
export async function autoFindOwner(lead: {
  businessName: string;
  website: string;
}): Promise<{ firstName: string; source: "parsed" | "ai"; fullName?: string; evidence?: string } | null> {
  const parsed = parseNameFromBusiness(lead.businessName);
  if (parsed) {
    return {
      firstName: parsed.firstName,
      source: "parsed",
      fullName: parsed.fullName,
      evidence: `Read from the business name "${lead.businessName}".`,
    };
  }

  if (lead.website.trim()) {
    const pages = await fetchOwnerPages(lead.website);
    if (pages.length) {
      const ai = await extractOwnerWithAI(lead.businessName, pages.map((p) => ({ url: p.url, text: p.text })));
      if (ai) return { firstName: ai.firstName, source: "ai", fullName: ai.fullName, evidence: ai.evidence };
    }
  }
  return null;
}

/** Manual "Find on website" button: fetch the site once, try AI, then the free
    JSON-LD/regex extraction. Pre-fills a suggestion for the owner to confirm —
    higher-recall (and lower-bar) than the auto path on purpose. */
export async function findOwnerFromWebsite(website: string, businessName = ""): Promise<OwnerGuess | null> {
  const pages = await fetchOwnerPages(website);
  if (!pages.length) return null;

  const ai = await extractOwnerWithAI(businessName, pages.map((p) => ({ url: p.url, text: p.text })));
  if (ai) {
    return {
      firstName: ai.firstName,
      fullName: ai.fullName,
      context: ai.evidence,
      sourceUrl: pages[0].url,
      source: "ai",
      confidence: ai.confidence,
    };
  }
  return extractOwnerFree(pages);
}
