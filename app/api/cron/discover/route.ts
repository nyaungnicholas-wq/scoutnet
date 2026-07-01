import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { processJobs } from "@/lib/agent/jobs";
import { processOwnersCron } from "@/lib/agent/owners";

/* Background-discovery worker. Vercel cron hits this to drain queued sweeps a
   bounded number of batches at a time (so no single invocation runs long).
   Same CRON_SECRET guard as the dispatch cron; open in dev for zero-config tests. */
function authorized(req: NextRequest): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/discover] CRON_SECRET is not set — all requests are rejected");
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
  const result = await processJobs(db, { maxBatches: 40 });
  // Also drain pending owner-name lookups across accounts (free engine), so the
  // greeting personalizes even when nobody has the dashboard open.
  const owners = await processOwnersCron(db, { maxLeads: 12 });
  return NextResponse.json({ ok: true, ...result, owners });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
