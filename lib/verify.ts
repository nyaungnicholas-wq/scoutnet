import { redactEmails } from "@/lib/crypto";

/* ─────────────────────────── email verification ───────────────────────────
   Before outreach touches a discovered address we ask: is this safe to send to?
   A hard bounce on the owner's OWN mailbox dents their sending reputation, so we
   verify first. "valid" is auto-sendable; "accept_all" (a catch-all domain that
   accepts everything, so we can't confirm the box exists) is held for human
   review; "invalid"/"disposable" are never sent.

   This module is pure I/O at the edges and never throws: a real provider is used
   when an API key is present (NeverBounce, then ZeroBounce), otherwise a fully
   deterministic demo verifier drives the dev loop with no network and no account.
   The pipeline owns persistence — we only return results, we never touch the DB. */

export type VerifyStatus = "valid" | "invalid" | "accept_all" | "disposable" | "unknown";

export type VerifyResult = {
  status: VerifyStatus;
  /** Confidence 0–100. Higher = safer to send. */
  score: number;
  provider: string;
};

export interface EmailVerifier {
  name: string;
  verify(email: string): Promise<VerifyResult>;
}

/* Canonical score per status, so every provider reports on one scale:
   valid is trustworthy, accept_all is a coin-flip we hold for review, unknown is
   inconclusive, and invalid/disposable are hard "do not send". */
const SCORE: Record<VerifyStatus, number> = {
  valid: 95,
  accept_all: 55,
  unknown: 40,
  disposable: 5,
  invalid: 5,
};

function result(status: VerifyStatus, provider: string): VerifyResult {
  return { status, score: SCORE[status], provider };
}

/* ───────────────────────────── NeverBounce ─────────────────────────────────
   POST https://api.neverbounce.com/v4/single/check with key+email as query
   params. NeverBounce returns { result: "valid" | "invalid" | "catchall" |
   "disposable" | "unknown" | ... }. */
export function neverbounceVerifier(apiKey: string): EmailVerifier {
  return {
    name: "neverbounce",
    async verify(email: string): Promise<VerifyResult> {
      const url = new URL("https://api.neverbounce.com/v4/single/check");
      url.searchParams.set("key", apiKey);
      url.searchParams.set("email", email);

      const res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return result("unknown", "neverbounce");
      }
      const data = (await res.json()) as { result?: string };
      const status = mapNeverbounce(data.result);
      return result(status, "neverbounce");
    },
  };
}

function mapNeverbounce(r: string | undefined): VerifyStatus {
  switch (r) {
    case "valid":
      return "valid";
    case "invalid":
      return "invalid";
    case "catchall":
      return "accept_all";
    case "disposable":
      return "disposable";
    default:
      return "unknown";
  }
}

/* ───────────────────────────── ZeroBounce ──────────────────────────────────
   GET https://api.zerobounce.net/v2/validate?api_key=&email=. ZeroBounce returns
   { status: "valid" | "invalid" | "catch-all" | "disposable" | "do_not_mail" |
   "spamtrap" | "abuse" | "unknown" | ... }. do_not_mail/spamtrap/abuse are
   treated as hard "do not send" → invalid. */
export function zerobounceVerifier(apiKey: string): EmailVerifier {
  return {
    name: "zerobounce",
    async verify(email: string): Promise<VerifyResult> {
      const url = new URL("https://api.zerobounce.net/v2/validate");
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("email", email);

      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return result("unknown", "zerobounce");
      }
      const data = (await res.json()) as { status?: string };
      const status = mapZerobounce(data.status);
      return result(status, "zerobounce");
    },
  };
}

function mapZerobounce(s: string | undefined): VerifyStatus {
  switch (s) {
    case "valid":
      return "valid";
    case "invalid":
      return "invalid";
    case "catch-all":
      return "accept_all";
    case "disposable":
      return "disposable";
    case "do_not_mail":
    case "spamtrap":
    case "abuse":
      return "invalid";
    default:
      return "unknown";
  }
}

/* ─────────────────────────────── demo ──────────────────────────────────────
   A PURE FUNCTION of the email string: no network, no clock, no randomness — the
   SAME email always yields the SAME result, and the rule set is shaped so the dev
   loop exercises every status branch. Rules are applied in order:

     1. empty / no "@"                                  → unknown (0)
     2. local part is a role alias                      → accept_all (55)
        {info, sales, support, admin, office, contact,
         hello, team, noreply, no-reply}
     3. domain in the disposable set                    → disposable (5)
        {mailinator.com, guerrillamail.com,
         10minutemail.com, tempmail.com}
     4. email contains "quiet"/"catchall"/"parked"      → accept_all (55)
     5. email contains "invalid"/"bounce", or local
        part is "x"/"test"                              → invalid (5)
     6. otherwise: deterministic hash (sum of char
        codes mod 100) → <75 valid (95), <90
        accept_all (55), else unknown (40)

   Note rule 1 returns score 0 (not the canonical unknown 40) to mirror the empty
   path in verifyEmail. */
const ROLE_LOCALPARTS: ReadonlySet<string> = new Set([
  "info",
  "sales",
  "support",
  "admin",
  "office",
  "contact",
  "hello",
  "team",
  "noreply",
  "no-reply",
]);

const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
]);

export function demoVerifier(): EmailVerifier {
  return {
    name: "demo",
    async verify(email: string): Promise<VerifyResult> {
      return demoVerify(email);
    },
  };
}

function demoVerify(email: string): VerifyResult {
  const e = email.trim().toLowerCase();

  // 1. empty / malformed
  const at = e.indexOf("@");
  if (!e || at < 0) return { status: "unknown", score: 0, provider: "demo" };

  const local = e.slice(0, at);
  const domain = e.slice(at + 1);

  // 2. role-based local part — generic inbox, can't confirm a person
  if (ROLE_LOCALPARTS.has(local)) return result("accept_all", "demo");

  // 3. known disposable domains
  if (DISPOSABLE_DOMAINS.has(domain)) return result("disposable", "demo");

  // 4. catch-all / parked markers anywhere in the address
  if (e.includes("quiet") || e.includes("catchall") || e.includes("parked")) {
    return result("accept_all", "demo");
  }

  // 5. explicit bad markers / placeholder locals
  if (e.includes("invalid") || e.includes("bounce") || local === "x" || local === "test") {
    return result("invalid", "demo");
  }

  // 6. deterministic fallback so most normal addresses land "valid"
  let sum = 0;
  for (let i = 0; i < e.length; i++) sum += e.charCodeAt(i);
  const h = sum % 100;
  if (h < 75) return result("valid", "demo");
  if (h < 90) return result("accept_all", "demo");
  return result("unknown", "demo");
}

/* ──────────────────────────── selection / entry ────────────────────────────
   Prefer a real provider when its key is present; fall back to the demo verifier
   so the product works with zero config. */
export function getVerifier(): EmailVerifier {
  const neverbounce = process.env.NEVERBOUNCE_API_KEY;
  if (neverbounce) return neverbounceVerifier(neverbounce);

  const zerobounce = process.env.ZEROBOUNCE_API_KEY;
  if (zerobounce) return zerobounceVerifier(zerobounce);

  return demoVerifier();
}

/** Verify one address. Empty input short-circuits to a no-provider unknown. Any
    network failure degrades to unknown (never throws), and the offending email is
    redacted out of any log line. */
export async function verifyEmail(email: string): Promise<VerifyResult> {
  if (!email || !email.trim()) {
    return { status: "unknown", score: 0, provider: "none" };
  }

  const verifier = getVerifier();
  try {
    return await verifier.verify(email);
  } catch (err) {
    console.error(`[verify] ${verifier.name} failed:`, redactEmails(String(err)));
    return { status: "unknown", score: 0, provider: verifier.name };
  }
}
