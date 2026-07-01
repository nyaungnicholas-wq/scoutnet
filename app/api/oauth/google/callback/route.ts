import { NextRequest, NextResponse } from "next/server";
import { mailboxConnections } from "@/db/schema";
import { getSessionAccount } from "@/lib/auth";
import { encryptSecret, verifySignedToken } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { exchangeCode } from "@/lib/mailbox/gmail";

/* Land the OAuth grant: verify the state matches the signed-in account, trade
   the code for tokens, and upsert the connection (tokens AES-256-GCM encrypted
   at rest). Any failure redirects back to Settings with a generic error — we
   never leak provider detail into the URL. */
export async function GET(req: NextRequest) {
  const settings = (q: string) => NextResponse.redirect(new URL(`/dashboard/settings?${q}`, req.nextUrl));

  const account = await getSessionAccount();
  if (!account) return NextResponse.redirect(new URL("/signin", req.nextUrl));

  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";

  /* Verify the signed state is intact AND was minted for this exact account. */
  const payload = verifySignedToken(state);
  if (!code || payload !== `oauth:${account.id}`) {
    return settings("mailboxError=connect-failed");
  }

  try {
    /* Must be byte-identical to the redirectUri used in /start. */
    const redirectUri = new URL("/api/oauth/google/callback", req.nextUrl.origin).toString();
    const grant = await exchangeCode(code, redirectUri);

    const db = await getDb();
    await db
      .insert(mailboxConnections)
      .values({
        accountId: account.id,
        provider: "gmail",
        email: grant.email,
        accessTokenEnc: encryptSecret(grant.accessToken),
        refreshTokenEnc: encryptSecret(grant.refreshToken),
        tokenExpiresAt: grant.expiresAt,
        grantedScopes: grant.scopes,
        status: "connected",
      })
      .onConflictDoUpdate({
        target: [mailboxConnections.accountId, mailboxConnections.email],
        set: {
          provider: "gmail",
          accessTokenEnc: encryptSecret(grant.accessToken),
          refreshTokenEnc: encryptSecret(grant.refreshToken),
          tokenExpiresAt: grant.expiresAt,
          grantedScopes: grant.scopes,
          status: "connected",
        },
      });

    return settings("connected=1");
  } catch (err) {
    console.error("[mailbox] gmail connect failed:", String(err));
    return settings("mailboxError=connect-failed");
  }
}
