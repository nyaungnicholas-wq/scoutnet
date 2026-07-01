import { NextRequest, NextResponse } from "next/server";
import { getSessionAccount } from "@/lib/auth";
import { signToken } from "@/lib/crypto";
import { googleAuthUrl, googleConfigured } from "@/lib/mailbox/gmail";

/* Kick off the Gmail OAuth dance. State is a signed token bound to the account
   id, so the callback can prove the grant came back to the same logged-in user
   (CSRF-resistant, no server-side state row). */
export async function GET(req: NextRequest) {
  const account = await getSessionAccount();
  if (!account) return NextResponse.redirect(new URL("/signin", req.nextUrl));

  if (!googleConfigured()) {
    return NextResponse.redirect(
      new URL("/dashboard/settings?mailboxError=not-configured", req.nextUrl)
    );
  }

  const state = signToken(`oauth:${account.id}`);
  const redirectUri = new URL("/api/oauth/google/callback", req.nextUrl.origin).toString();
  return NextResponse.redirect(googleAuthUrl(state, redirectUri));
}
