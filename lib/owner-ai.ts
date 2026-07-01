/* AI owner extractor. Reads a business's OWN About/Team page text and pulls the
   owner/founder's name WITH the exact sentence as evidence — far more precise than
   the regex scrape (which is why this exists: it kills the "Hi Led," misfires that
   got the plain scrape distrusted). Uses Gemini via the Generative Language API.

   Key resolution: GEMINI_API_KEY, falling back to GOOGLE_PLACES_API_KEY — the same
   Google key already in .env.local works for Gemini the moment the "Gemini API" is
   enabled on that Cloud project. Returns null on ANY failure (no key, API disabled,
   bad JSON, nothing found) so the caller falls back cleanly to the free engine. */

const MODEL = "gemini-2.0-flash";

export function geminiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_PLACES_API_KEY || "").trim();
}

/** Where the AI key comes from — drives honest UI:
    - "explicit": a dedicated GEMINI_API_KEY is set (trusted live).
    - "places":   no Gemini key, but we can REUSE GOOGLE_PLACES_API_KEY — which only
                  works once the "Gemini API" is enabled on that Google project, so
                  the UI prompts that one remaining click instead of claiming "on".
    - "none":     no key at all. */
export function geminiKeySource(): "explicit" | "places" | "none" {
  if ((process.env.GEMINI_API_KEY || "").trim()) return "explicit";
  if ((process.env.GOOGLE_PLACES_API_KEY || "").trim()) return "places";
  return "none";
}

/** Whether an AI key is configured at all (so the extractor is worth attempting). */
export function aiOwnerEnabled(): boolean {
  return geminiKey().length > 0;
}

/* When the project's Gemini API is disabled (403 SERVICE_DISABLED), the same error
   would repeat for every lead in a discovery batch. Remember it briefly so we stop
   hammering and fall straight to the free engine until the user enables it. */
let disabledUntil = 0;

export type AiOwner = {
  firstName: string;
  fullName: string;
  role: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
};

/* OpenAPI-subset schema Gemini fills. Forcing JSON out removes all the brittle
   "parse the prose" failure modes the regex had. */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    firstName: { type: "string" },
    fullName: { type: "string" },
    role: { type: "string" },
    evidence: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["found"],
} as const;

function buildPrompt(businessName: string, corpus: string): string {
  return `You extract the OWNER of a local business from its own website text.

Business name: "${businessName}"

Website text (homepage + about / team / contact pages):
"""
${corpus}
"""

Return the FIRST NAME of the owner, founder, principal, or proprietor — the person who owns or runs this business.

Strict rules:
- Only return a name that the text EXPLICITLY identifies as the owner / founder / principal / proprietor. For a solo professional practice (a dentist, doctor, lawyer, chiropractor) the named practitioner the business is built around counts.
- Use the person's real given name, properly capitalised (e.g. "Mike", "Dana").
- NEVER invent or guess a name from the business name, a slogan, a navigation label, or a customer-review author. If no owner is clearly named, set found:false.
- "evidence" must be the exact sentence or phrase from the text that names them.
- "confidence": high = explicit ("Owner: X", "founded by X", "Dr. X, owner"); medium = strongly implied; low = weak.`;
}

/** Extract the owner from already-fetched page text. Network + JSON only; never
    throws. `pages` is the cleaned text of the homepage and a few about/team pages. */
export async function extractOwnerWithAI(
  businessName: string,
  pages: { url: string; text: string }[]
): Promise<AiOwner | null> {
  const key = geminiKey();
  if (!key) return null;
  if (Date.now() < disabledUntil) return null; // API known-disabled; skip the round-trip

  const corpus = pages
    .map((p) => `# ${p.url}\n${p.text}`)
    .join("\n\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
  if (corpus.length < 40) return null;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(businessName, corpus) }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 256,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
      }
    );
    if (!res.ok) {
      // 403 = Gemini API not enabled on this project (or key lacks access). Back
      // off for 10 minutes so we don't retry it on every lead in the batch.
      if (res.status === 403) disabledUntil = Date.now() + 10 * 60_000;
      return null;
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      found?: boolean;
      firstName?: string;
      fullName?: string;
      role?: string;
      evidence?: string;
      confidence?: string;
    };
    if (!parsed.found) return null;

    const first = (parsed.firstName || "").trim().split(/\s+/)[0]?.replace(/[^A-Za-z'’.-]/g, "") ?? "";
    // Must look like a real given name — letters, 2+ chars, starts uppercase.
    if (first.length < 2 || !/^[A-Za-z]/.test(first)) return null;
    const norm = first[0].toUpperCase() + first.slice(1).toLowerCase();
    const confidence =
      parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : "medium";

    return {
      firstName: norm,
      fullName: (parsed.fullName || norm).trim().slice(0, 80),
      role: (parsed.role || "owner").trim().slice(0, 40),
      evidence: (parsed.evidence || "").trim().slice(0, 200),
      confidence,
    };
  } catch {
    return null;
  }
}
