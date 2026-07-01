import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { pollReplies, runDispatch, runFollowups } from "@/lib/dispatch";

/* The outreach dispatcher. Vercel cron hits this on a schedule (daily minimum on
   Hobby — see vercel.json). Protected by CRON_SECRET: in production the secret is
   required and passed via the Authorization header (a query param would leak it
   into access logs); in dev it's open so the loop is testable with zero config. */
function authorized(req: NextRequest): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    /* Loud, so an operator sees why nothing is ever dispatched. */
    console.error("[cron] CRON_SECRET is not set — all dispatch requests are rejected");
    return false;
  }
  const auth = req.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb();
  // Detect replies first so a prospect who answered isn't followed up this run,
  // then openers (hybrid auto-send), then any follow-ups that have come due.
  const replies = await pollReplies(db, {});
  const openers = await runDispatch(db, { origin: req.nextUrl.origin });
  const followups = await runFollowups(db, { origin: req.nextUrl.origin });
  return NextResponse.json({ ok: true, replies, openers, followups });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
