import { and, count, eq, gte } from "drizzle-orm";
import { accounts, leadSends, profiles } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { getActiveMailbox } from "@/lib/mailbox";

type ProfileRow = typeof profiles.$inferSelect;

export type SendChannel = "mailbox" | "resend" | "none";

/** Platform-wide ceiling on per-account daily outreach. Owners set their own
    profile.dailyCap but can never exceed this. */
const DAILY_CAP_MAX = (() => {
  const raw = Number(process.env.OUTREACH_DAILY_CAP_MAX);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
})();

const DAY_MS = 24 * 60 * 60_000;

/** Strip CRLF so business-controlled merge values can't inject email headers. */
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** True when emails land in the dev outbox instead of real inboxes. */
export function devTransport(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.DEV_OUTBOX === "1";
}

/** Cold outreach may only leave through the owner's own key + domain. One source
    of truth — the dispatcher, the lead page, and the settings UI all ask this. In
    dev the key requirement is waived (the dev outbox is the transport). NOTE: the
    postal-address (CAN-SPAM) requirement was removed at the owner's request for a
    manual, low-volume workflow — re-add it here + in withFooter before any
    automated bulk sending. */
export function senderReady(profile: ProfileRow | undefined): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!profile) return { ok: false, missing: ["sender profile"] };
  if (!profile.resendKeyEnc && !devTransport()) missing.push("Resend API key");
  if (!profile.fromAddr.trim()) missing.push("from address on your domain");
  return { ok: missing.length === 0, missing };
}

/** Whole-account send readiness across BOTH channels. A connected mailbox (Gmail)
    is the preferred channel; otherwise fall back to the Resend key + own-domain
    path. `via` tells the dispatcher which channel to use. */
export async function accountSendStatus(
  db: Db,
  profile: ProfileRow | undefined
): Promise<{ ok: boolean; missing: string[]; via: SendChannel }> {
  if (!profile) return { ok: false, missing: ["sender profile"], via: "none" };
  const missing: string[] = [];

  const mailbox = await getActiveMailbox(db, profile.accountId);
  if (mailbox) {
    return { ok: missing.length === 0, missing, via: "mailbox" };
  }
  if (!profile.resendKeyEnc && !devTransport()) missing.push("connect a mailbox, or add a Resend key");
  if (!profile.fromAddr.trim()) missing.push("connect a mailbox, or set a from address");
  return { ok: missing.length === 0, missing, via: missing.length === 0 ? "resend" : "none" };
}

/* Warm-up ramp. A brand-new sending domain that blasts its full daily volume on
   day one looks exactly like a spammer to Gmail/Yahoo and gets throttled into the
   spam folder. The effective cap starts at a low floor and climbs to the owner's
   target over the first weeks of actual sending. */
const WARMUP_FLOOR = 10; // emails/day on day 0
const WARMUP_STEP = 5; // added per day of sending history

export function warmupCap(startedAt: Date | null, target: number, now: Date = new Date()): number {
  if (!startedAt) return Math.min(target, WARMUP_FLOOR);
  const days = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS));
  return Math.min(target, WARMUP_FLOOR + days * WARMUP_STEP);
}

export function inWarmup(profile: ProfileRow, now: Date = new Date()): boolean {
  const target = Math.min(Math.max(1, profile.dailyCap), DAILY_CAP_MAX);
  return warmupCap(profile.warmupStartedAt, target, now) < target;
}

/** The cap the dispatcher actually enforces today: the owner's target, the
    platform ceiling, and the warm-up ramp — whichever is lowest. */
export function effectiveDailyCap(profile: ProfileRow, now: Date = new Date()): number {
  const target = Math.min(Math.max(1, profile.dailyCap), DAILY_CAP_MAX);
  return Math.min(target, warmupCap(profile.warmupStartedAt, target, now));
}

/** Cold sends in the trailing 24h — counts attempts (ok or not) so a failing key
    can't burn unlimited tries against the cap. */
export async function sendsInLastDay(db: Db, accountId: string): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const [{ value }] = await db
    .select({ value: count() })
    .from(leadSends)
    .where(and(eq(leadSends.accountId, accountId), gte(leadSends.sentAt, since)));
  return value;
}

/** Decrypt the owner's stored Resend key, or undefined if absent/corrupt. */
export function ownKey(profile: ProfileRow): string | undefined {
  if (!profile.resendKeyEnc) return undefined;
  try {
    return decryptSecret(profile.resendKeyEnc);
  } catch {
    return undefined;
  }
}

export function baseUrl(): string {
  const configured = process.env.APP_BASE_URL;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    /* A localhost unsubscribe link in a real email is a CAN-SPAM failure — make
       the misconfiguration loud rather than shipping broken links. */
    throw new Error("APP_BASE_URL must be set in production (used to build unsubscribe links)");
  }
  return "http://localhost:3000";
}

export async function accountEmail(db: Db, accountId: string): Promise<string> {
  const rows = await db.select({ email: accounts.email }).from(accounts).where(eq(accounts.id, accountId));
  return rows[0]?.email ?? "";
}

/* Append a minimal, human opt-out to every outreach email. Per the owner's
   request, the business name + postal address are NOT included in the body (it's
   a manual, low-volume workflow). The one-click List-Unsubscribe HEADER still
   carries unsubUrl, so recipients can still be suppressed. Re-add a postal address
   here before any automated bulk sending (CAN-SPAM). */
export function withFooter(body: string, _profile: ProfileRow, _unsubUrl: string): string {
  return `${body.trim()}\n\nNot the right time? Just reply and I won't follow up.`;
}
