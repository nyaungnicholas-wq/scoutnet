import { and, eq, gt } from "drizzle-orm";
import { accounts, verifiedAddresses } from "@/db/schema";
import { randomToken, sha256hex } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { sendEmail } from "@/lib/email";

const VERIFY_TTL_MINUTES = 60 * 24; // 24h

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** Seed the login email as a verified address. Idempotent — safe to call on
    every sign-in. The magic link already proved ownership. */
export async function ensureLoginAddressVerified(db: Db, accountId: string, email: string): Promise<void> {
  const norm = normalizeEmail(email);
  const existing = await db
    .select()
    .from(verifiedAddresses)
    .where(and(eq(verifiedAddresses.accountId, accountId), eq(verifiedAddresses.email, norm)));
  if (existing[0]?.verified) return;
  if (existing[0]) {
    await db
      .update(verifiedAddresses)
      .set({ verified: true, verifyTokenHash: null, verifyExpiresAt: null })
      .where(eq(verifiedAddresses.id, existing[0].id));
    return;
  }
  await db.insert(verifiedAddresses).values({ accountId, email: norm, verified: true });
}

export async function isAddressVerified(db: Db, accountId: string, email: string): Promise<boolean> {
  const norm = normalizeEmail(email);
  const rows = await db
    .select({ verified: verifiedAddresses.verified })
    .from(verifiedAddresses)
    .where(and(eq(verifiedAddresses.accountId, accountId), eq(verifiedAddresses.email, norm)));
  return rows[0]?.verified === true;
}

/** Return `desired` only if it's a verified address for this account; otherwise
    fall back to the always-verified login email. This is what stops an owner
    from pointing a reply-to at an address they haven't confirmed. */
export async function verifiedOrFallback(
  db: Db,
  accountId: string,
  desired: string | null | undefined,
  loginEmail: string
): Promise<string> {
  const d = (desired ?? "").trim();
  if (!d || normalizeEmail(d) === normalizeEmail(loginEmail)) return loginEmail;
  if (await isAddressVerified(db, accountId, d)) return d;
  /* The owner configured an address but never confirmed it — we fall back to the
     login email rather than silently dropping the mail. Make the substitution
     visible so it doesn't look like it "just worked". */
  console.warn(`[addresses] account ${accountId}: configured address is unverified, using login email instead`);
  return loginEmail;
}

/** Start (or restart) click-to-verify for an address. Returns the dev link when
    the dev-outbox transport handled the email, so local testing needs no inbox. */
export async function requestAddressVerification(
  db: Db,
  accountId: string,
  rawEmail: string,
  baseUrl: string
): Promise<{ ok: boolean; error?: string; devLink?: string }> {
  const email = normalizeEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That email doesn't look right." };

  const acct = (await db.select().from(accounts).where(eq(accounts.id, accountId)))[0];
  if (acct && normalizeEmail(acct.email) === email) {
    await ensureLoginAddressVerified(db, accountId, email);
    return { ok: true };
  }

  const token = randomToken(32);
  const tokenHash = sha256hex(token);
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MINUTES * 60_000);
  const existing = await db
    .select()
    .from(verifiedAddresses)
    .where(and(eq(verifiedAddresses.accountId, accountId), eq(verifiedAddresses.email, email)));
  if (existing[0]) {
    await db
      .update(verifiedAddresses)
      .set({ verifyTokenHash: tokenHash, verifyExpiresAt: expiresAt })
      .where(eq(verifiedAddresses.id, existing[0].id));
  } else {
    await db.insert(verifiedAddresses).values({ accountId, email, verified: false, verifyTokenHash: tokenHash, verifyExpiresAt: expiresAt });
  }

  const link = `${baseUrl}/api/verify-address?token=${token}`;
  const result = await sendEmail(db, {
    to: email,
    subject: "Confirm this email for ScoutNet",
    body: `Confirm you want ScoutNet to use ${email} as a reply-to for your outreach:\n\n${link}\n\nThis link expires in 24 hours. If you didn't request it, ignore this email.`,
    bodyForRecord: `Confirm this address for ScoutNet: ${baseUrl}/api/verify-address?token=[token-redacted]`,
    kind: "verify",
    accountId,
  });
  if (!result.ok) return { ok: false, error: "Could not send the confirmation email." };
  return {
    ok: true,
    ...(result.sentVia === "dev-outbox" && process.env.NODE_ENV !== "production" ? { devLink: link } : {}),
  };
}

export async function confirmAddressToken(db: Db, token: string): Promise<boolean> {
  /* Atomic claim: only an unexpired, matching token flips verified — and the
     hash is nulled in the same statement, so a token is single-use. */
  const claimed = await db
    .update(verifiedAddresses)
    .set({ verified: true, verifyTokenHash: null, verifyExpiresAt: null })
    .where(
      and(
        eq(verifiedAddresses.verifyTokenHash, sha256hex(token)),
        gt(verifiedAddresses.verifyExpiresAt, new Date())
      )
    )
    .returning({ id: verifiedAddresses.id });
  return claimed.length > 0;
}
