import type { DiscoveryProvider, LeadSignals } from "@/db/schema";
import { getVertical, type Vertical } from "@/lib/verticals";

/* The "search the web for businesses" layer. Three interchangeable providers,
   newest-data-first:

     places  — Google Places API (real, richest local data). Needs
               GOOGLE_PLACES_API_KEY. Auto-selected when the key is present.
     osm     — OpenStreetMap via Nominatim + Overpass (real, free, no key). The
               honest zero-cost path: real businesses, though sparser contact data.
     sample  — deterministic demo data (no network). Mirrors the dev-outbox idea:
               the whole discover → score → draft → send loop is testable with no
               keys and no internet, on clearly-labelled fake businesses.

   Every provider returns the same RawCandidate shape; enrichment + scoring don't
   care where a candidate came from. */

export type RawCandidate = {
  businessName: string;
  website: string; // "" when none is known — itself a strong signal
  email: string;
  phone: string;
  address: string;
  mapsUrl: string;
  source: string;
  /** Provider-supplied stability signals, when available. */
  rating: number | null;
  reviewCount: number | null;
  ageYears: number | null;
  /** Only the sample provider sets this — pre-baked signals so enrichment skips
      the (pointless) network fetch of a fake domain. */
  demoSignals?: LeadSignals;
};

const FETCH_TIMEOUT = 12_000;

/** Which providers can actually run right now, best-data-first. The UI uses this
    to default the picker and explain why Places may be unavailable. */
export function availableProviders(): { key: DiscoveryProvider; label: string; ready: boolean; note: string }[] {
  const hasPlaces = Boolean(process.env.GOOGLE_PLACES_API_KEY);
  return [
    {
      key: "places",
      label: "Google Places",
      ready: hasPlaces,
      note: hasPlaces ? "Richest data: ratings, review counts, websites." : "Add GOOGLE_PLACES_API_KEY to enable.",
    },
    { key: "osm", label: "OpenStreetMap (free)", ready: true, note: "Real businesses, no key. Sparser contact data." },
    { key: "sample", label: "Sample data (demo)", ready: true, note: "Fake businesses for testing the pipeline." },
  ];
}

export function defaultProvider(): DiscoveryProvider {
  return process.env.GOOGLE_PLACES_API_KEY ? "places" : "osm";
}

export async function discover(
  provider: DiscoveryProvider,
  verticalKey: string,
  location: string,
  count: number,
  radiusMiles: number = 25
): Promise<{ candidates: RawCandidate[]; note: string }> {
  const vertical = getVertical(verticalKey);
  // Synchronous runs clamp count to 150 in the action (enrichment time); the
  // background-job path stages up to 600 candidates here and enriches in batches.
  const n = Math.max(1, Math.min(count, 600));
  const radius = Math.max(1, Math.min(radiusMiles, 50));
  try {
    if (provider === "places") return await fromPlaces(vertical, location, n, radius);
    if (provider === "osm") return await fromOsm(vertical, location, n, radius);
    return fromSample(vertical, location, n);
  } catch (err) {
    /* Discovery never throws into the pipeline — a provider outage returns an
       empty set with an honest note rather than failing the whole run. */
    return { candidates: [], note: `Provider error: ${String(err).slice(0, 160)}` };
  }
}

/* Shared geocoder — turn a free-text place into a center point via Nominatim.
   Used by both the OSM and Places providers to honour the radius. */
async function geocode(location: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const geo = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
      { headers: { "User-Agent": "ScoutNetBot/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT) }
    );
    if (!geo.ok) return null;
    const places = (await geo.json()) as Array<{ lat: string; lon: string }>;
    if (!places.length) return null;
    return { lat: Number(places[0].lat), lon: Number(places[0].lon) };
  } catch {
    return null;
  }
}

/* ───────────────────────── Google Places (real) ─────────────────────────
   The richest source: real per-business websites (which enrichment then fetches
   to scrape a contact email and score the gaps) plus ratings + review counts for
   the income score. Honours the radius via a locationBias circle (Places caps a
   circle at 50 km) and paginates up to the requested count. */

type PlaceResult = {
  displayName?: { text?: string };
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
};

async function fromPlaces(vertical: Vertical, location: string, n: number, radiusMiles: number): Promise<{ candidates: RawCandidate[]; note: string }> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { candidates: [], note: "Google Places not configured (no GOOGLE_PLACES_API_KEY)." };

  const center = await geocode(location);
  // Places circle radius is capped at 50 km; a 50-mile ask is clamped (with note).
  const radiusM = Math.min(Math.round(radiusMiles * 1609.34), 50_000);

  const all: PlaceResult[] = [];
  let pageToken: string | undefined;
  // Up to 3 pages (Places returns ≤20/page → ≤60), and never more than asked.
  for (let page = 0; page < 3 && all.length < n; page++) {
    const body: Record<string, unknown> = {
      textQuery: `${vertical.placesQuery} in ${location}`,
      maxResultCount: 20,
      ...(center ? { locationBias: { circle: { center: { latitude: center.lat, longitude: center.lon }, radius: radiusM } } } : {}),
      ...(pageToken ? { pageToken } : {}),
    };
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "nextPageToken,places.displayName,places.websiteUri,places.rating,places.userRatingCount,places.formattedAddress,places.nationalPhoneNumber,places.googleMapsUri",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) {
      if (all.length) break; // keep what we have
      return { candidates: [], note: `Google Places error ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }
    const data = (await res.json()) as { places?: PlaceResult[]; nextPageToken?: string };
    all.push(...(data.places ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  const seen = new Set<string>();
  const candidates: RawCandidate[] = [];
  for (const p of all) {
    const name = (p.displayName?.text ?? "").trim();
    if (!name || seen.has(name.toLowerCase()) || isNonProspect(name)) continue;
    seen.add(name.toLowerCase());
    candidates.push({
      businessName: name.slice(0, 160),
      website: (p.websiteUri ?? "").slice(0, 300),
      email: "",
      phone: (p.nationalPhoneNumber ?? "").slice(0, 40),
      address: (p.formattedAddress ?? "").slice(0, 300),
      mapsUrl: (p.googleMapsUri ?? "").slice(0, 300),
      source: "google_places",
      rating: typeof p.rating === "number" ? p.rating : null,
      reviewCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
      ageYears: null,
    });
    if (candidates.length >= n) break;
  }
  const clamped = radiusMiles * 1609.34 > 50_000 ? " (radius clamped to 50 km — Places' max)" : "";
  return { candidates, note: candidates.length ? clamped.trim() : "Google Places returned no results for that query." };
}

/* ────────────────── OpenStreetMap: Nominatim + Overpass (free) ────────── */

async function fromOsm(
  vertical: Vertical,
  location: string,
  n: number,
  radiusMiles: number
): Promise<{ candidates: RawCandidate[]; note: string }> {
  const ua = "ScoutNetBot/1.0 (business discovery; respects robots)";
  // 1. Geocode the location to a center point.
  const geo = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
    { headers: { "User-Agent": ua, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT) }
  );
  if (!geo.ok) return { candidates: [], note: `Could not geocode "${location}" (Nominatim ${geo.status}).` };
  const places = (await geo.json()) as Array<{ lat: string; lon: string }>;
  if (!places.length) return { candidates: [], note: `No map location found for "${location}".` };
  const { lat, lon } = places[0];

  // 2. Overpass: businesses matching this vertical's tags within the radius.
  const radius = Math.round(radiusMiles * 1609.34); // miles → metres
  const tagBlocks = vertical.osm
    .map((t) => {
      const [k, v] = t.split("=");
      // No value (e.g. "shop") or "=yes" → match any value of that key.
      const sel = !v || v === "yes" ? `["${k}"]` : `["${k}"="${v}"]`;
      return `node${sel}(around:${radius},${lat},${lon});way${sel}(around:${radius},${lat},${lon});`;
    })
    .join("");
  // Pull a generous candidate pool (many lack names/websites and get filtered),
  // capped so a 50-mile "all businesses" sweep can't ask Overpass for the world.
  const overpassCap = Math.min(Math.max(n * 3, 120), 600);
  const query = `[out:json][timeout:90];(${tagBlocks});out tags center ${overpassCap};`;
  const op = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua },
    body: `data=${encodeURIComponent(query)}`,
    // A wide multi-tag "all businesses" sweep is heavy server-side; give Overpass
    // room to answer (its own query timeout is 90s) before we abort the fetch.
    signal: AbortSignal.timeout(95_000),
  });
  if (!op.ok) return { candidates: [], note: `OpenStreetMap query failed (Overpass ${op.status}).` };
  const result = (await op.json()) as { elements?: Array<{ tags?: Record<string, string> }> };

  const seen = new Set<string>();
  const candidates: RawCandidate[] = [];
  for (const el of result.elements ?? []) {
    const tags = el.tags ?? {};
    const name = (tags.name ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    // Skip national chains / franchises / malls — not prospects for a local
    // web-design or marketing freelancer, and they pollute a broad sweep.
    if (isNonProspect(name)) continue;
    const website = (tags.website ?? tags["contact:website"] ?? tags.url ?? "").trim();
    const phone = (tags.phone ?? tags["contact:phone"] ?? "").trim();
    const email = (tags.email ?? tags["contact:email"] ?? "").trim();
    /* Require a way to reach them. A business with no website, no phone, and no
       email is unactionable (and usually a thinly-mapped POI), so drop it rather
       than fill the queue with dead ends. A phone-only lead is kept — it's a call
       list; a website lets enrichment scrape an email. */
    if (!website && !phone && !email) continue;
    seen.add(name.toLowerCase());
    const addr = [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"], tags["addr:postcode"]]
      .filter(Boolean)
      .join(" ")
      .trim();
    candidates.push({
      businessName: name.slice(0, 160),
      website: website.slice(0, 300),
      email: email.slice(0, 160),
      phone: phone.slice(0, 40),
      address: addr.slice(0, 300),
      mapsUrl: "",
      source: "openstreetmap",
      rating: null,
      reviewCount: null,
      ageYears: null,
    });
    if (candidates.length >= n) break;
  }
  return {
    candidates,
    note: candidates.length ? "" : `OpenStreetMap had no ${vertical.label} tagged near "${location}".`,
  };
}

/* National/regional chains, franchises, and non-pitchable POIs. A local web or
   marketing freelancer can't sell to a Chevron or an Applebee's, so they're noise
   in a broad sweep. Matched case-insensitively as whole words against the name. */
const CHAIN_DENYLIST: string[] = [
  // fuel
  "chevron", "shell", "arco", "mobil", "76", "valero", "exxon", "circle k", "am pm", "ampm",
  // fast food / casual chains
  "mcdonald", "starbucks", "subway", "burger king", "wendy", "taco bell", "del taco", "jack in the box",
  "carl's jr", "in-n-out", "in n out", "chick-fil-a", "chipotle", "panera", "kfc", "popeyes", "raising cane",
  "pizza hut", "domino", "papa john", "little caesar", "round table", "applebee", "chili's", "tgi friday",
  "el torito", "olive garden", "ihop", "denny", "panda express", "dunkin", "jersey mike", "jamba", "wingstop",
  "buffalo wild wings", "five guys", "shake shack", "sonic", "arby", "el pollo loco",
  // retail / grocery / pharmacy / telecom / banks
  "walmart", "target", "costco", "sam's club", "cvs", "walgreens", "rite aid", "7-eleven", "7 eleven",
  "at&t", "t-mobile", "verizon", "sprint", "metro pcs", "metropcs", "cricket wireless", "boost mobile",
  "wells fargo", "chase", "bank of america", "u.s. bank", "us bank", "citibank", "citizens bank", "pnc",
  "home depot", "lowe's", "best buy", "fedex", "ups store", "usps", "albertsons", "vons", "ralphs",
  "stater bros", "trader joe", "whole foods", "sprouts", "aldi", "kroger", "safeway", "food 4 less",
  "ross", "marshalls", "tj maxx", "t.j. maxx", "nordstrom", "macy", "kohl", "dollar tree", "dollar general", "99 cents",
  // auto / services chains
  "jiffy lube", "valvoline", "autozone", "o'reilly", "oreilly", "pep boys", "firestone", "midas", "meineke",
  "enterprise", "hertz", "avis", "u-haul", "uhaul", "discount tire", "americas tire", "les schwab",
  "great clips", "supercuts", "sport clips", "fantastic sams",
  // healthcare systems
  "kaiser", "cvs minute", "quest diagnostics", "labcorp",
  // hardware / more food & retail chains that slip through broad sweeps
  "ace hardware", "true value", "harbor freight", "bb.q chicken", "bbq chicken", "blaze pizza",
  "mountain mike", "the habit", "rubio", "wienerschnitzel", "baskin", "cold stone", "menchie",
  "coffee bean", "peet's", "paris baguette", "85", "sharetea", "7 leaves", "lee's sandwiches",
  "wachovia", "washington mutual", "h&r block", "jackson hewitt", "ross dress", "big lots",
  "petco", "petsmart", "gnc", "vitamin shoppe", "sally beauty", "ulta", "sephora", "gamestop",
  "foot locker", "planet fitness", "la fitness", "24 hour fitness", "crunch fitness", "anytime fitness",
  "orangetheory", "massage envy", "european wax", "drybar", "mathnasium", "kumon", "chuck e cheese",
  "dave & buster", "99 ranch", "h mart", "hmart", "seafood city", "smart & final", "grocery outlet",
  "food 4 less", "cardenas", "el super", "vallarta", "superior grocers", "pizza factory", "round table",
];

const NON_PROSPECT_RE = /\b(mall|shopping center|town center|outlet|plaza shopping|food court|gas station|car wash)\b/i;

function isNonProspect(name: string): boolean {
  const n = name.toLowerCase();
  if (NON_PROSPECT_RE.test(name)) return true;
  return CHAIN_DENYLIST.some((brand) => {
    // word-boundary-ish: brand appears as a token, not a substring of another word
    const re = new RegExp(`(^|[^a-z0-9])${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    return re.test(n);
  });
}

/* ─────────────────────── Sample data (deterministic) ──────────────────── */

const SURNAMES = ["Hartwell", "Brennan", "Castillo", "Okafor", "Nguyen", "Delgado", "Whitaker", "Sorensen", "Patel", "Romano", "Fairbanks", "Underwood"];

/* Five recurring "site health" archetypes, cycled by index, so a sample run
   shows the full spread the scorer is built to separate. */
const ARCHETYPES: Array<{ label: string; mk: (i: number) => { website: string; signals: LeadSignals } }> = [
  {
    label: "no website at all",
    mk: () => ({ website: "", signals: baseSignals({ hasWebsite: false, reachable: false, fetched: false, rating: 4.6, reviewCount: 180, ageYears: 14 }) }),
  },
  {
    label: "parked / coming-soon page",
    mk: (i) => ({ website: `https://example-parked-${i}.com`, signals: baseSignals({ https: true, parking: true, builder: "godaddy", mobileFriendly: false, rating: 4.7, reviewCount: 240, ageYears: 18 }) }),
  },
  {
    label: "dated DIY site, no SSL, not mobile",
    mk: (i) => ({ website: `http://example-old-${i}.com`, signals: baseSignals({ https: false, mobileFriendly: false, builder: "wix", staleCopyright: true, copyrightYear: 2016, slow: true, hasContactForm: false, rating: 4.4, reviewCount: 95, ageYears: 11 }) }),
  },
  {
    label: "decent site but dead marketing",
    mk: (i) => ({ website: `https://example-quiet-${i}.com`, signals: baseSignals({ https: true, mobileFriendly: true, builder: "wordpress", copyrightYear: 2023, hasContactForm: true, hasEmailCapture: false, socials: {}, rating: 3.9, reviewCount: 22, ageYears: 9 }) }),
  },
  {
    label: "strong site and presence",
    mk: (i) => ({ website: `https://example-strong-${i}.com`, signals: baseSignals({ https: true, mobileFriendly: true, builder: "wordpress", copyrightYear: 2025, hasContactForm: true, hasBooking: true, hasEmailCapture: true, socials: { facebook: true, instagram: true }, rating: 4.9, reviewCount: 410, ageYears: 16 }) }),
  },
];

function baseSignals(over: Partial<LeadSignals>): LeadSignals {
  return {
    fetched: true,
    reachable: true,
    hasWebsite: true,
    https: true,
    mobileFriendly: true,
    builder: null,
    parking: false,
    copyrightYear: 2024,
    staleCopyright: false,
    hasContactForm: true,
    hasBooking: false,
    hasEmailCapture: false,
    pageBytes: 120_000,
    slow: false,
    rating: null,
    reviewCount: null,
    ageYears: null,
    socials: {},
    emailFound: null,
    ...over,
  };
}

function fromSample(vertical: Vertical, location: string, n: number): { candidates: RawCandidate[]; note: string } {
  const cityTag = location.split(",")[0].trim() || "Townsville";
  const tradeWord = vertical.label.split(/[/—]/)[0].trim();
  const candidates: RawCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const arch = ARCHETYPES[i % ARCHETYPES.length];
    const { website, signals } = arch.mk(i);
    const name = `${SURNAMES[i % SURNAMES.length]} ${tradeWord}`;
    const slug = SURNAMES[i % SURNAMES.length].toLowerCase();
    candidates.push({
      businessName: name,
      website,
      // A reachable demo email so the send loop is exercisable end-to-end.
      email: website ? `owner@example-${slug}-${i}.com` : `${slug}.${vertical.key}@example.com`,
      phone: `(555) 0${(100 + i).toString().slice(-2)}-${(2000 + i * 7).toString().slice(-4)}`,
      address: `${100 + i * 3} Main St, ${cityTag}`,
      mapsUrl: "",
      source: `sample:${arch.label}`,
      rating: signals.rating,
      reviewCount: signals.reviewCount,
      ageYears: signals.ageYears,
      demoSignals: signals,
    });
  }
  return { candidates, note: `Sample data — ${n} fake ${vertical.label} businesses for testing.` };
}
