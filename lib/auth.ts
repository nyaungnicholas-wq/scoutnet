import { and, count, eq, gt, gte, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { accounts, magicTokens, sessions } from "@/db/schema";
import { ensureLoginAddressVerified } from "@/lib/addresses";
import { randomToken, sha256hex } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { sendEmail } from "@/lib/email";

export const SESSION_COOKIE = "sn_session";
const SESSION_DAYS = 30;
const MAGIC_LINK_MINUTES = 15;
const MAGIC_LINKS_PER_EMAIL_PER_10MIN = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RequestLinkResult = {
  ok: boolean;
  error?: string;
  /** Only populated when the dev outbox transport handled the send (never in production). */
  devLink?: string;
};

export async function requestMagicLink(
  emailRaw: string,
  baseUrl: string
): Promise<RequestLinkResult> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "That email address doesn't look right." };

  const db = await getDb();

  /* Quietly cap link requests per email — same generic response either way so
     the endpoint can't be used to probe or spam. Insert-then-count (deleting
     our own row when over) instead of count-then-insert, so concurrent
     requests can't all slip under the cap. */
  const token = randomToken(32);
  const tokenHash = sha256hex(token);
  await db.insert(magicTokens).values({
    tokenHash,
    email,
    expiresAt: new Date(Date.now() + MAGIC_LINK_MINUTES * 60_000),
  });
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);
  const [{ value: recent }] = await db
    .select({ value: count() })
    .from(magicTokens)
    .where(and(eq(magicTokens.email, email), gte(magicTokens.createdAt, tenMinAgo)));
  if (recent > MAGIC_LINKS_PER_EMAIL_PER_10MIN) {
    await db.delete(magicTokens).where(eq(magicTokens.tokenHash, tokenHash));
    return { ok: true };
  }

  const link = `${baseUrl}/api/auth/verify?token=${token}`;
  const bodyFor = (t: string) =>
    `Sign in to ScoutNet:\n\n${baseUrl}/api/auth/verify?token=${t}\n\nThis link expires in ${MAGIC_LINK_MINUTES} minutes and can be used once. If you didn't request it, you can ignore this email.`;
  const result = await sendEmail(db, {
    to: email,
    subject: "Your ScoutNet sign-in link",
    body: bodyFor(token),
    /* The raw token must never persist in the outbox table. */
    bodyForRecord: bodyFor("[token-redacted]"),
    kind: "magic-link",
  });

  if (!result.ok) return { ok: false, error: "Could not send the sign-in email. Try again in a minute." };
  return {
    ok: true,
    ...(result.sentVia === "dev-outbox" && process.env.NODE_ENV !== "production"
      ? { devLink: link }
      : {}),
  };
}

export async function verifyMagicToken(
  token: string
): Promise<{ sessionToken: string } | { error: string }> {
  const db = await getDb();
  const now = new Date();

  /* Atomic claim: UPDATE ... RETURNING marks the token used and fails for
     anyone racing with the same link. */
  const claimed = await db
    .update(magicTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(magicTokens.tokenHash, sha256hex(token)),
        isNull(magicTokens.usedAt),
        gt(magicTokens.expiresAt, now)
      )
    )
    .returning({ email: magicTokens.email });
  if (claimed.length === 0) return { error: "expired" };

  const email = claimed[0].email;
  const existing = await db.select().from(accounts).where(eq(accounts.email, email));
  const account =
    existing[0] ??
    (await db.insert(accounts).values({ email }).returning())[0];

  /* The login email is proven by this very link — seed it as a verified reply-to
     address so the owner can work replies with zero further setup. */
  await ensureLoginAddressVerified(db, account.id, email);

  const sessionToken = randomToken(32);
  await db.insert(sessions).values({
    tokenHash: sha256hex(sessionToken),
    accountId: account.id,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
  });
  return { sessionToken };
}

export type SessionAccount = { id: string; email: string };

/* cache() deduplicates the cookie read + DB join across the layout and page of
   a single server render pass. */
export const getSessionAccount = cache(async (): Promise<SessionAccount | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const rows = await db
    .select({ id: accounts.id, email: accounts.email })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.tokenHash, sha256hex(token)), gt(sessions.expiresAt, new Date())));
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email };
});

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return;
  try {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.tokenHash, sha256hex(token)));
  } catch (err) {
    /* The caller clears the cookie regardless — a DB blip must not block sign-out. */
    console.error("[auth] session delete failed during sign-out:", err);
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  };
}
