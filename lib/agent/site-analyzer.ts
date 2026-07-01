import { validateUrl } from "@/lib/ssrf";

/* The Outbound Setup Agent's site reader. Deterministic heuristics only — no LLM.
   Fetches the owner's public website (SSRF-guarded) and extracts what's needed
   to stand up an outreach identity: business name, phone, postal address, accent
   color, and the trade (vertical). Every field degrades gracefully so a missing
   or unreachable site never blocks onboarding. */

export type Vertical = "realtor" | "contractor" | "attorney" | "salon" | "generic";

export type Field<T> = { value: T; source: string; confidence: "high" | "medium" | "low" };

export type SiteAnalysis = {
  ok: boolean;
  /** Present when the site couldn't be read; onboarding falls back to manual entry. */
  warning?: string;
  url?: string;
  businessName: Field<string>;
  phone: Field<string>;
  address: Field<string>;
  vertical: Field<Vertical>;
  accent: Field<string>;
};

const MAX_BYTES = 512 * 1024;

/* Distinctive trade nouns only — generic cross-industry words (appointment,
   booking, free consultation, free estimate) are deliberately excluded because
   every service business uses them and they wreck discrimination. */
const VERTICAL_KEYWORDS: Record<Exclude<Vertical, "generic">, string[]> = {
  realtor: ["real estate", "realtor", "realty", "homes for sale", "mls", "listing", "buyers agent", "sellers agent", "open house", "home value", "property for sale", "dre #"],
  contractor: ["plumbing", "plumber", "hvac", "electrician", "electrical", "roofing", "roofer", "remodel", "renovation", "drain", "sewer", "furnace", "water heater", "handyman", "general contractor", "licensed & insured"],
  attorney: ["attorney", "lawyer", "law firm", "law office", "litigation", "counsel", "practice areas", "esq.", "probate", "personal injury", "paralegal", "criminal defense"],
  salon: ["salon", "barber", "hair stylist", "nails", "manicure", "pedicure", "lash", "waxing", "blowout", "haircut", "spa", "massage therapist"],
};

const DEFAULT_ACCENT: Record<Vertical, string> = {
  realtor: "#0d3050",
  contractor: "#06547e",
  attorney: "#0a4364",
  salon: "#9d174d",
  generic: "#0369a1",
};

function field<T>(value: T, source: string, confidence: Field<T>["confidence"]): Field<T> {
  return { value, source, confidence };
}

function titleToBusinessName(title: string): string {
  // Drop a trailing "| tagline" / "— tagline" / "- City" suffix; keep the lead segment.
  const lead = title.split(/\s[|–—-]\s/)[0].trim();
  return (lead || title).slice(0, 120);
}

function domainName(host: string): string {
  const bare = host.replace(/^www\./, "").split(".")[0];
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/* Decode the handful of HTML entities common in titles/meta so an extracted
   business name reads "Smith & Sons", not "Smith &amp; Sons". */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function firstMatch(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  const v = m?.[1]?.trim();
  return v ? decodeEntities(v) : undefined;
}

function collectJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
        if (node && typeof node === "object") out.push(node as Record<string, unknown>);
        const graph = (node as Record<string, unknown>)?.["@graph"];
        if (Array.isArray(graph)) for (const g of graph) if (g && typeof g === "object") out.push(g);
      }
    } catch {
      /* malformed JSON-LD — skip */
    }
  }
  return out;
}

function jsonLdString(nodes: Record<string, unknown>[], key: string): string | undefined {
  for (const n of nodes) {
    const v = n[key];
    if (typeof v === "string" && v.trim()) return decodeEntities(v.trim());
  }
  return undefined;
}

function jsonLdAddress(nodes: Record<string, unknown>[]): string | undefined {
  for (const n of nodes) {
    const a = n.address;
    if (a && typeof a === "object" && !Array.isArray(a)) {
      const o = a as Record<string, unknown>;
      const parts = [o.streetAddress, o.addressLocality, o.addressRegion, o.postalCode]
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
      if (parts.length) return parts.join(", ").slice(0, 300);
    }
    if (typeof a === "string" && a.trim()) return a.trim().slice(0, 300);
  }
  return undefined;
}

function detectVertical(text: string): Field<Vertical> {
  const hay = text.toLowerCase();
  let best: Exclude<Vertical, "generic"> | null = null;
  let bestDistinct = 0;
  let bestTotal = 0;
  for (const [v, words] of Object.entries(VERTICAL_KEYWORDS) as [Exclude<Vertical, "generic">, string[]][]) {
    let distinct = 0;
    let total = 0;
    for (const w of words) {
      const n = hay.split(w).length - 1;
      if (n > 0) {
        distinct += 1;
        total += n;
      }
    }
    /* Rank by how many DISTINCT trade terms appear (one word repeated 19× is weak
       signal; five different plumbing terms is strong); break ties on volume. */
    if (distinct > bestDistinct || (distinct === bestDistinct && total > bestTotal)) {
      bestDistinct = distinct;
      bestTotal = total;
      best = v;
    }
  }
  if (!best || bestDistinct === 0) return field<Vertical>("generic", "no clear trade keywords found", "low");
  return field<Vertical>(
    best,
    `matched ${bestDistinct} distinct "${best}" term(s) on your site`,
    bestDistinct >= 2 ? "high" : "medium"
  );
}

function formatPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  const ten = digits.replace(/^\+?1?/, "");
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return raw.trim().slice(0, 30);
}

/** Builds a fallback analysis from just the URL (site unreadable or skipped).
    Exported so the onboarding page can render the manual-entry path
    (?url=skip) without fetching anything. Never throws. */
export function fallbackAnalysis(url: string | undefined, host: string | undefined, warning: string): SiteAnalysis {
  const name = host ? domainName(host) : "Your business";
  return {
    ok: false,
    warning,
    url,
    businessName: field(name, "your website address", "low"),
    phone: field("", "not found — please add it", "low"),
    address: field("", "not found — please add it", "low"),
    vertical: field<Vertical>("generic", "couldn't read your site", "low"),
    accent: field(DEFAULT_ACCENT.generic, "default", "low"),
  };
}

export async function analyzeSite(rawUrl: string): Promise<SiteAnalysis> {
  let normalized = rawUrl.trim();
  if (normalized && !/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;

  const checked = validateUrl(normalized);
  if (!checked.ok) {
    return fallbackAnalysis(normalized || undefined, undefined, `That URL can't be used (${checked.reason}).`);
  }
  const url = checked.url;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  })();

  /* Follow redirects MANUALLY (not redirect:"follow") so every hop's Location is
     re-validated against the SSRF guard — a public site must not be able to bounce
     us to an internal address. Real sites commonly 301 from apex→www or http→https,
     so refusing all redirects would make the agent fall back on perfectly good
     sites. Cap at 4 hops. */
  let html: string;
  let current = url;
  try {
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "ScoutNetSetupBot/1.0", Accept: "text/html" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        const next = validateUrl(new URL(loc, current).href);
        if (!next.ok) return fallbackAnalysis(url, host, "Your site redirected somewhere we can't follow.");
        current = next.url;
        continue;
      }
      break;
    }
    if (!res) return fallbackAnalysis(url, host, "We couldn't reach that site — check the address.");
    if (!res.ok) return fallbackAnalysis(url, host, `Your site returned an error (${res.status}).`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html") && !ct.includes("text")) return fallbackAnalysis(url, host, "That link isn't a web page.");
    const buf = await res.arrayBuffer();
    html = Buffer.from(buf.slice(0, MAX_BYTES)).toString("utf8");
  } catch {
    return fallbackAnalysis(url, host, "We couldn't reach that site — check the address.");
  }

  const nodes = collectJsonLd(html);
  const ogName = firstMatch(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  const title = firstMatch(html, /<title[^>]*>([^<]+)<\/title>/i);
  const ldName = jsonLdString(nodes, "name");
  const metaDesc = firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ?? "";
  const themeColor = firstMatch(html, /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{6})["']/i);

  const businessName = ogName
    ? field(ogName.slice(0, 120), "your site's name (og:site_name)", "high")
    : ldName
      ? field(ldName.slice(0, 120), "your site's business listing", "high")
      : title
        ? field(titleToBusinessName(title), "your site's title", "medium")
        : field(host ? domainName(host) : "Your business", "your website address", "low");

  const telHref = firstMatch(html, /href=["']tel:([^"']+)["']/i);
  const ldPhone = jsonLdString(nodes, "telephone");
  const textPhone = firstMatch(html, /(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  const phone = telHref
    ? field(formatPhone(telHref), "a tap-to-call link on your site", "high")
    : ldPhone
      ? field(formatPhone(ldPhone), "your site's business listing", "high")
      : textPhone
        ? field(formatPhone(textPhone), "a phone number on your page", "medium")
        : field("", "not found — please add it", "low");

  const ldAddr = jsonLdAddress(nodes);
  const address = ldAddr
    ? field(ldAddr, "your site's business listing", "high")
    : field("", "not found — please add it", "low");

  const verticalText = [title ?? "", metaDesc, url, html.replace(/<[^>]+>/g, " ").slice(0, 20000)].join(" ");
  const vertical = detectVertical(verticalText);

  const accent = themeColor
    ? field(themeColor, "your site's theme color", "medium")
    : field(DEFAULT_ACCENT[vertical.value], "a default for your trade", "low");

  return { ok: true, url, businessName, phone, address, vertical, accent };
}
