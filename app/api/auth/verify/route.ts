import { NextRequest, NextResponse } from "next/server";
import { sessionCookieOptions, SESSION_COOKIE, verifyMagicToken } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) return NextResponse.redirect(new URL("/signin?error=invalid", req.nextUrl));

  const result = await verifyMagicToken(token);
  if ("error" in result) {
    return NextResponse.redirect(new URL("/signin?error=expired", req.nextUrl));
  }
  const res = NextResponse.redirect(new URL("/dashboard", req.nextUrl));
  res.cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions());
  return res;
}
