import { NextRequest, NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: NextRequest) {
  /* destroySession is best-effort (it logs DB failures internally); the cookie
     is cleared no matter what, so sign-out always works client-side. */
  await destroySession();
  const res = NextResponse.redirect(new URL("/", req.nextUrl), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
